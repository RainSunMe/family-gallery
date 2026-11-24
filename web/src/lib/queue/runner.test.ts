import { beforeEach, describe, expect, it, vi } from 'vitest';

// The runner touches the network, the decoder and the hasher. All three are
// replaced so the test can observe the pipeline order rather than the bytes.
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  checkDuplicates: vi.fn(),
  buildDerivatives: vi.fn(),
  createSession: vi.fn(),
  sendOriginal: vi.fn(),
  sendDerivatives: vi.fn(),
  completeSession: vi.fn(),
  listServerParts: vi.fn(),
  resignUpload: vi.fn(),
  hashOne: vi.fn(),
  captureTimeOf: vi.fn(),
}));

vi.mock('../api', () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  uploadParts: mocks.listServerParts,
  resignUpload: mocks.resignUpload,
}));

vi.mock('../upload', () => ({
  checkDuplicates: mocks.checkDuplicates,
  buildDerivatives: mocks.buildDerivatives,
  createSession: mocks.createSession,
  sendOriginal: mocks.sendOriginal,
  sendDerivatives: mocks.sendDerivatives,
  completeSession: mocks.completeSession,
}));

vi.mock('../hash', () => ({ hashOne: mocks.hashOne }));
vi.mock('../exif', () => ({ captureTimeOf: mocks.captureTimeOf }));
vi.mock('../decode', () => ({
  resolveMime: () => 'image/jpeg',
  SUPPORTED_MIME: ['image/jpeg'],
}));

import { resetMemory, getRecord, getQueue, getCompletedTick } from './store';
import { enqueue, cancel, mobileLimit, rebindSource, resetRunnerState } from './runner';
import type { UploadSource } from './source';

const grant = (id: string, multipart = true) => ({
  id, key: `photos/originals/${id}/original`, url: multipart ? '' : 'https://s3/put',
  thumb_url: 'https://s3/thumb', preview_url: 'https://s3/preview',
  multipart_upload_id: multipart ? `mp-${id}` : '', part_size: 8,
});

function source(size: number): { source: UploadSource; entries: { name: string; size: number; mtime: number }[] } {
  const file = new File([new Uint8Array(Math.min(size, 16))], 'a.jpg', { type: 'image/jpeg', lastModified: 1234 });
  // The size in the record and the File's real size must agree for the pipeline.
  const entry = { name: 'a.jpg', size: file.size, mtime: 1234, file };
  return {
    entries: [entry],
    source: {
      kind: 'files',
      resumable: false,
      async list() { return [entry]; },
      async open() { return file; },
    },
  };
}

async function settle(predicate: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      const state = getQueue().map(item => ({ id: item.id, status: item.status, attempts: item.attempts, error: item.error }));
      throw new Error(`pipeline did not settle: ${JSON.stringify(state)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  resetMemory();
  vi.clearAllMocks();
  // Batch claims live outside individual records, so they have to be dropped too.
  resetRunnerState();
  mocks.hashOne.mockResolvedValue('hash-1');
  mocks.checkDuplicates.mockResolvedValue({ duplicates: {}, new: ['hash-1'], legacy_photos: 0 });
  mocks.buildDerivatives.mockResolvedValue({ width: 10, height: 10, thumb: new Blob(), preview: new Blob() });
  mocks.captureTimeOf.mockResolvedValue('');
  mocks.sendOriginal.mockResolvedValue([]);
  mocks.sendDerivatives.mockResolvedValue(undefined);
  mocks.completeSession.mockResolvedValue('photo-1');
  mocks.listServerParts.mockResolvedValue({ parts: [], part_size: 8 });
});

describe('upload queue runner', () => {
  it('runs a file through every step and then drops the row', async () => {
    mocks.createSession.mockResolvedValue(grant('u1'));
    const { source: src, entries } = source(16);

    const [record] = await enqueue('session-1', 'album-1', src, entries);
    // A finished row leaves the page: the queue is a work list, so completion is
    // observed as the row disappearing plus the tick the shell listens to.
    await settle(() => !getRecord(record.id));

    expect(getCompletedTick()).toBe(1);
    expect(getQueue()).toHaveLength(0);
    expect(mocks.hashOne).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.sendOriginal).toHaveBeenCalledTimes(1);
    expect(mocks.sendDerivatives).toHaveBeenCalledTimes(1);
    expect(mocks.completeSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession.mock.calls[0][0].clientMtime).toBe(1234);
  });

  it('skips a file the album already holds', async () => {
    mocks.checkDuplicates.mockResolvedValue({
      duplicates: { 'hash-1': { id: 'p', name: 'a.jpg', contributor: '', taken_at: '', thumb_url: '' } },
      new: [], legacy_photos: 0,
    });
    const { source: src, entries } = source(16);

    const [record] = await enqueue('session-1', 'album-1', src, entries);
    await settle(() => getRecord(record.id)?.status === 'skipped');

    // Nothing was transferred: that is the whole point of checking first.
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendOriginal).not.toHaveBeenCalled();
  });

  it('persists each accepted part', async () => {
    mocks.createSession.mockResolvedValue(grant('u1'));
    // Capture the record while it is still in the queue: completion removes it.
    let snapshot: { parts: { n: number; size: number }[] } | undefined;
    mocks.sendDerivatives.mockImplementation(async () => {
      snapshot = getRecord(recordId);
    });
    let recordId = '';
    mocks.sendOriginal.mockImplementation(async (_file, _grant, options) => {
      options.onPart({ n: 1, size: 8, etag: 'e1' });
      options.onPart({ n: 2, size: 8, etag: 'e2' });
      return [];
    });
    const { source: src, entries } = source(16);

    const [record] = await enqueue('session-1', 'album-1', src, entries);
    recordId = record.id;
    await settle(() => !getRecord(record.id));

    expect(snapshot?.parts.map(part => part.n)).toEqual([1, 2]);
    expect(snapshot?.parts.map(part => part.size)).toEqual([8, 8]);
  });

  it('resumes an interrupted upload without resending finished parts', async () => {
    const { source: src, entries } = source(16);
    // A session that already has both parts in the bucket.
    mocks.resignUpload.mockResolvedValue(grant('u9'));
    mocks.listServerParts.mockResolvedValue({
      parts: [{ part_number: 1, etag: 'e1', size: 8 }, { part_number: 2, etag: 'e2', size: 8 }],
      part_size: 8,
    });

    // Seed the record the way a reload would find it.
    const { upsertRecord } = await import('./store');
    await upsertRecord({
      id: 'r9', sessionId: 'session-1', albumId: 'album-1', name: 'a.jpg', size: 16, mtime: 1234,
      mime: 'image/jpeg', sourceKey: 'a.jpg|16|1234', uploadId: 'u9', key: 'k', hash: 'hash-1',
      parts: [], status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1,
    });
    // Register the source without enqueueing another file, and let the seeded
    // record pick up where it stopped.
    await rebindSource('session-1', src, entries);
    await settle(() => !getRecord('r9'));

    // createSession must not run again: that would orphan the uploaded parts.
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.resignUpload).toHaveBeenCalledWith('u9');
    const options = mocks.sendOriginal.mock.calls[0][2];
    expect([...options.skip].sort()).toEqual([1, 2]);
  });

  it('starts a fresh session when the old one was reclaimed', async () => {
    const { ApiError } = await import('../api');
    mocks.createSession.mockResolvedValue(grant('fresh'));
    mocks.resignUpload.mockRejectedValue(new (ApiError as unknown as new (s: number, c: string, m: string) => Error)(409, 'UPLOAD_EXPIRED', 'expired'));
    const { source: src, entries } = source(16);

    const { upsertRecord } = await import('./store');
    await upsertRecord({
      id: 'r7', sessionId: 'session-1', albumId: 'album-1', name: 'a.jpg', size: 16, mtime: 1234,
      mime: 'image/jpeg', sourceKey: 'a.jpg|16|1234', uploadId: 'gone', key: 'k', hash: 'hash-1',
      parts: [], status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1,
    });
    // Register the source without enqueueing another file, and let the seeded
    // record pick up where it stopped.
    // Capture the adopted session before the row is removed on completion.
    let adopted: string | undefined;
    mocks.sendDerivatives.mockImplementation(async () => { adopted = getRecord('r7')?.uploadId; });
    await rebindSource('session-1', src, entries);

    await settle(() => !getRecord('r7'));
    // It retried once, dropped the dead session and opened a new one.
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(adopted).toBe('fresh');
  });

  it('marks a record waiting when its source is gone', async () => {
    const { upsertRecord } = await import('./store');
    await upsertRecord({
      id: 'orphan', sessionId: 'forgotten', albumId: 'album-1', name: 'a.jpg', size: 16, mtime: 1,
      mime: 'image/jpeg', sourceKey: 'a.jpg|16|1', parts: [], status: 'queued',
      attempts: 0, createdAt: 1, updatedAt: 1,
    });

    // Pump by enqueueing an unrelated file into a known session.
    const { source: src, entries } = source(16);
    mocks.createSession.mockResolvedValue(grant('u2'));
    await enqueue('session-2', 'album-1', src, entries);

    await settle(() => getRecord('orphan')?.status === 'waiting');
  });

  it('removes a cancelled record and aborts its session', async () => {
    mocks.api.mockResolvedValue(undefined);
    const { upsertRecord } = await import('./store');
    await upsertRecord({
      id: 'c1', sessionId: 's', albumId: 'a', name: 'x.jpg', size: 1, mtime: 1, mime: 'image/jpeg',
      sourceKey: 'x.jpg|1|1', uploadId: 'u5', parts: [], status: 'queued', attempts: 0,
      createdAt: 1, updatedAt: 1,
    });
    await cancel('c1');
    expect(getRecord('c1')).toBeUndefined();
    expect(mocks.api).toHaveBeenCalledWith('/uploads/u5', { method: 'DELETE' });
  });

  it('only reports a mobile cap on coarse pointers', () => {
    // No matchMedia in the test environment, so the desktop rules apply.
    expect(mobileLimit([{ size: 1024 }])).toBe('ok');
  });
});

describe('queue ordering', () => {
  it('keeps the enqueue order in the list', async () => {
    const { source: src, entries } = source(8);
    await enqueue('order-1', 'album-1', src, entries);
    await enqueue('order-2', 'album-1', src, entries);
    const names = getQueue().map(item => item.sessionId);
    expect(names).toEqual([...names].sort((a, b) => (a === 'order-1' ? -1 : 1) - (b === 'order-1' ? -1 : 1)));
  });
});
