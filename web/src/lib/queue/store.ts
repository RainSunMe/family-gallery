// The queue's in-memory view, mirrored to IndexedDB.
//
// Reads go through a single immutable snapshot so React can subscribe with
// useSyncExternalStore (the same pattern identity.ts uses). Writes persist
// asynchronously: losing a write to a storage error must not stop an upload, it
// only costs the ability to resume that one file.

import { useSyncExternalStore } from 'react';
import type { QueueRecord, QueueStatus } from './types';
import { allRecords, deleteRecord, putRecord, putRecords } from './db';

const records = new Map<string, QueueRecord>();
const listeners = new Set<() => void>();
const tickListeners = new Set<() => void>();
let snapshot: QueueRecord[] = [];
// Completed rows leave the page immediately, but the shell still needs to know a
// photo landed. A counter carries that signal after the row itself is gone.
let completedTick = 0;

/**
 * Batch totals that survive row removal.
 *
 * Completed rows are deleted, so deriving "total" from the rows still on screen
 * would make the shared progress bar jump backwards every time a file finished.
 * These counters are the stable denominator: totals are added at enqueue and only
 * reduced when the user actually withdraws a file.
 */
type Ledger = { total: number; totalBytes: number; resolved: number; resolvedBytes: number };
let ledger: Ledger = { total: 0, totalBytes: 0, resolved: 0, resolvedBytes: 0 };

function resetLedger() {
  ledger = { total: 0, totalBytes: 0, resolved: 0, resolvedBytes: 0 };
}

/**
 * Empty queue means a fresh batch starts at zero.
 *
 * Without this the ledger keeps the previous batch's totals forever, so a new
 * batch would open with the bar already part-filled from work that is no longer
 * on screen.
 */
function resetLedgerWhenEmpty() {
  if (records.size === 0) resetLedger();
}

function publish() {
  // Insertion order is the order files were added. Sorting by updatedAt would
  // reshuffle rows on every progress tick.
  snapshot = [...records.values()].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  for (const listener of listeners) listener();
}

export function getLedger(): Ledger {
  return ledger;
}

export function getCompletedTick(): number {
  return completedTick;
}

function subscribeCompleted(listener: () => void): () => void {
  tickListeners.add(listener);
  return () => { tickListeners.delete(listener); };
}

export function useCompletedTick(): number {
  return useSyncExternalStore(subscribeCompleted, getCompletedTick, getCompletedTick);
}

export function getQueue(): QueueRecord[] {
  return snapshot;
}

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useQueue(): QueueRecord[] {
  return useSyncExternalStore(subscribeQueue, getQueue, getQueue);
}

export function getRecord(id: string): QueueRecord | undefined {
  return records.get(id);
}

export async function upsertRecord(record: QueueRecord): Promise<void> {
  records.set(record.id, record);
  publish();
  await putRecord(record);
}

/**
 * Add a whole batch at once.
 *
 * Adding records one by one published a new snapshot each time, so enqueuing 1000
 * files re-sorted and re-rendered the list 1000 times. One publish and one
 * transaction keep it linear.
 */
export async function upsertRecords(batch: QueueRecord[]): Promise<void> {
  if (!batch.length) return;
  for (const record of batch) records.set(record.id, record);
  ledger.total += batch.length;
  for (const record of batch) ledger.totalBytes += record.size;
  publish();
  await putRecords(batch);
}

/**
 * Merge a partial change into one record.
 *
 * Returns the updated record so the runner can keep working with the freshest
 * copy instead of a stale closure.
 */
export async function patchRecord(id: string, changes: Partial<QueueRecord>): Promise<QueueRecord | undefined> {
  const current = records.get(id);
  if (!current) return undefined;
  const next: QueueRecord = { ...current, ...changes, updatedAt: Date.now() };
  records.set(id, next);
  publish();
  await putRecord(next);
  return next;
}

export async function setStatus(id: string, status: QueueStatus, error?: string): Promise<QueueRecord | undefined> {
  return patchRecord(id, error === undefined ? { status } : { status, error });
}

export async function removeRecord(id: string): Promise<void> {
  const record = records.get(id);
  // Withdrawing a file lowers the denominator: the user asked for it to go away.
  if (record) {
    ledger.total = Math.max(0, ledger.total - 1);
    ledger.totalBytes = Math.max(0, ledger.totalBytes - record.size);
  }
  records.delete(id);
  publish();
  await deleteRecord(id);
  resetLedgerWhenEmpty();
}

/** Remove every finished row, optionally limited to one batch. */
export async function clearFinished(sessionId?: string): Promise<void> {
  const doomed = [...records.values()].filter(record =>
    (record.status === 'done' || record.status === 'skipped') && (!sessionId || record.sessionId === sessionId));
  for (const record of doomed) records.delete(record.id);
  if (!doomed.length) return;
  publish();
  await Promise.all(doomed.map(record => deleteRecord(record.id)));
}

/**
 * A photo finished uploading. Drop its row, tell the shell, and settle the ledger.
 *
 * The page is a work list, not a history: a completed row has nothing left to
 * act on, so keeping it would only push the rows that still matter off screen.
 * The tick is what lets the photo library refresh without the row existing.
 */
export async function finishRecord(id: string): Promise<void> {
  completedTick += 1;
  for (const listener of tickListeners) listener();
  const record = records.get(id);
  if (record) {
    // Only count bytes not already accounted for: a record that uploaded some
    // parts and was then dropped must not be added on top of those parts.
    ledger.resolved += 1;
    ledger.resolvedBytes += record.size;
  }
  records.delete(id);
  publish();
  await deleteRecord(id);
  resetLedgerWhenEmpty();
}

/** A skipped duplicate needs no further work, so it settles exactly like a success. */
export async function skipRecord(id: string): Promise<void> {
  const record = records.get(id);
  if (record) {
    ledger.resolved += 1;
    ledger.resolvedBytes += record.size;
  }
  await setStatus(id, 'skipped');
  resetLedgerWhenEmpty();
}

/** Records that still have work to do, oldest first. */
export function pendingRecords(): QueueRecord[] {
  return snapshot.filter(record => record.status === 'queued');
}

export function recordsForSession(sessionId: string): QueueRecord[] {
  return snapshot.filter(record => record.sessionId === sessionId);
}

/**
 * Load what a previous visit left behind. Everything that was mid-flight becomes
 * `waiting`: the file itself is gone from memory, so the only honest state is
 * "we know about this, it needs its source back".
 */
export async function hydrate(): Promise<QueueRecord[]> {
  resetLedger();
  const stored = await allRecords();
  // Rows that finished in a previous session are history; this page never shows
  // them, so load nothing that is already complete.
  const stale = stored.filter(record => record.status === 'done').map(record => record.id);
  await Promise.all(stale.map(id => deleteRecord(id)));
  for (const record of stored) {
    if (record.status === 'done' || records.has(record.id)) continue;
    // Mid-flight work becomes `waiting`: the file is gone from memory, so the
    // only honest state is "we know about this, it needs its source back".
    const status = record.status === 'skipped' || record.status === 'failed' ? record.status : 'waiting';
    records.set(record.id, { ...record, status });
    ledger.total += 1;
    ledger.totalBytes += record.size;
    if (status === 'skipped') {
      ledger.resolved += 1;
      ledger.resolvedBytes += record.size;
    }
  }
  publish();
  return snapshot;
}

/** Test hook: drop everything from memory without touching storage. */
export function resetMemory(): void {
  records.clear();
  publish();
}
