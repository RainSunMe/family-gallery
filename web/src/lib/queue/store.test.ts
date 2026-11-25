import { beforeEach, describe, expect, it } from 'vitest';
import type { QueueRecord } from './types';
import { uploadedBytes, isActive, isFinished } from './types';
import {
  clearFinished, getQueue, getRecord, getSummary, hydrate, patchRecord, pendingRecords,
  recordsForSession, removeRecord, resetMemory, setStatus, signalSummary, upsertRecord,
} from './store';

const record = (overrides: Partial<QueueRecord> = {}): QueueRecord => ({
  id: 'r1', sessionId: 's1', albumId: 'a1', name: 'a.jpg', size: 100, mtime: 1,
  mime: 'image/jpeg', sourceKey: 'a.jpg|100|1', parts: [], status: 'queued',
  attempts: 0, createdAt: 1, updatedAt: 1, ...overrides,
});

beforeEach(() => {
  resetMemory();
});

describe('progress accounting', () => {
  it('sums the parts that actually landed', () => {
    expect(uploadedBytes(record({ parts: [{ n: 1, size: 8, etag: '' }, { n: 2, size: 4, etag: '' }] }))).toBe(12);
  });

  it('is zero before anything is transferred', () => {
    expect(uploadedBytes(record())).toBe(0);
  });

  it('classifies statuses', () => {
    expect(isActive(record({ status: 'uploading' }))).toBe(true);
    expect(isActive(record({ status: 'done' }))).toBe(false);
    expect(isFinished(record({ status: 'skipped' }))).toBe(true);
    expect(isFinished(record({ status: 'failed' }))).toBe(false);
  });
});

describe('queue store', () => {
  it('publishes a new snapshot on write', async () => {
    await upsertRecord(record());
    expect(getQueue()).toHaveLength(1);
    await upsertRecord(record({ id: 'r2', createdAt: 2 }));
    expect(getQueue().map(item => item.id)).toEqual(['r1', 'r2']);
  });

  it('orders by enqueue time, not by the latest progress tick', async () => {
    await upsertRecord(record({ id: 'late', createdAt: 20 }));
    await upsertRecord(record({ id: 'early', createdAt: 10 }));
    await patchRecord('late', { status: 'uploading' });
    expect(getQueue().map(item => item.id)).toEqual(['early', 'late']);
  });

  it('merges a partial change and bumps updatedAt', async () => {
    await upsertRecord(record({ updatedAt: 1 }));
    const updated = await patchRecord('r1', { status: 'uploading', hash: 'abc' });
    expect(updated?.status).toBe('uploading');
    expect(updated?.hash).toBe('abc');
    expect(updated?.updatedAt).toBeGreaterThan(1);
  });

  it('ignores a patch for an unknown record', async () => {
    expect(await patchRecord('missing', { status: 'done' })).toBeUndefined();
  });

  it('keeps per-part progress when patched twice', async () => {
    await upsertRecord(record());
    await patchRecord('r1', { parts: [{ n: 1, size: 8, etag: 'e1' }] });
    await patchRecord('r1', { parts: [...(getRecord('r1')?.parts || []), { n: 2, size: 8, etag: 'e2' }] });
    expect(getRecord('r1')?.parts.map(part => part.n)).toEqual([1, 2]);
  });

  it('returns only queued records to the scheduler', async () => {
    await upsertRecord(record({ id: 'a', status: 'queued' }));
    await upsertRecord(record({ id: 'b', status: 'uploading' }));
    await upsertRecord(record({ id: 'c', status: 'waiting' }));
    expect(pendingRecords().map(item => item.id)).toEqual(['a']);
  });

  it('does not publish a new snapshot for a quiet progress write', async () => {
    await upsertRecord(record());
    const before = getQueue();
    // A part landing writes through to IndexedDB but must not hand every row a
    // new object: that is what used to re-render the list (and reload the
    // thumbnails) once per 8 MiB.
    await patchRecord('r1', { parts: [{ n: 1, size: 8, etag: 'e1' }] }, { quiet: true });
    expect(getQueue()).toBe(before);
    expect(getRecord('r1')?.parts).toHaveLength(1);
  });

  it('makes a quiet progress write visible to the bar', async () => {
    await upsertRecord(record({ status: 'uploading' }));
    await patchRecord('r1', { parts: [{ n: 1, size: 64, etag: 'e1' }] }, { quiet: true });
    signalSummary();
    // The bytes are visible to the bar even though no render happened.
    expect(getSummary().sent).toBe(64);
    expect(getSummary().uploading).toBe(1);
  });

  it('keeps the summary reference stable when nothing changed', async () => {
    await upsertRecord(record());
    signalSummary();
    const first = getSummary();
    // useSyncExternalStore treats a new object as a change. Re-signalling with
    // identical numbers must not build a new one, or React loops forever.
    signalSummary();
    expect(getSummary()).toBe(first);
  });

  it('removes a record', async () => {
    await upsertRecord(record());
    await removeRecord('r1');
    expect(getQueue()).toHaveLength(0);
  });

  it('clears finished rows only', async () => {
    await upsertRecord(record({ id: 'done', status: 'done' }));
    await upsertRecord(record({ id: 'skipped', status: 'skipped', createdAt: 2 }));
    await upsertRecord(record({ id: 'failed', status: 'failed', createdAt: 3 }));
    await clearFinished();
    expect(getQueue().map(item => item.id)).toEqual(['failed']);
  });

  it('clears finished rows for one batch only', async () => {
    await upsertRecord(record({ id: 'a', sessionId: 's1', status: 'done' }));
    await upsertRecord(record({ id: 'b', sessionId: 's2', status: 'done', createdAt: 2 }));
    await clearFinished('s1');
    expect(getQueue().map(item => item.id)).toEqual(['b']);
  });

  it('groups records by batch', async () => {
    await upsertRecord(record({ id: 'a', sessionId: 's1' }));
    await upsertRecord(record({ id: 'b', sessionId: 's2', createdAt: 2 }));
    expect(recordsForSession('s2').map(item => item.id)).toEqual(['b']);
  });

  it('marks an interrupted record as waiting on hydrate', async () => {
    // Simulates what a reload sees: a row persisted while it was uploading.
    await upsertRecord(record({ id: 'mid', status: 'uploading' }));
    resetMemory();
    await hydrate();
    expect(getRecord('mid')?.status).toBe('waiting');
  });

  it('drops completed rows on hydrate', async () => {
    // The page is a work list, not a history: a photo that finished in a previous
    // session has nothing left to act on.
    await upsertRecord(record({ id: 'ok', status: 'done' }));
    await upsertRecord(record({ id: 'bad', status: 'failed', createdAt: 2 }));
    resetMemory();
    await hydrate();
    expect(getRecord('ok')).toBeUndefined();
    expect(getRecord('bad')?.status).toBe('failed');
  });

  it('setStatus records the error when one is supplied', async () => {
    await upsertRecord(record());
    await setStatus('r1', 'failed', 'boom');
    expect(getRecord('r1')?.error).toBe('boom');
  });
});
