// The queue's in-memory view, mirrored to IndexedDB.
//
// Reads go through a single immutable snapshot so React can subscribe with
// useSyncExternalStore (the same pattern identity.ts uses). Writes persist
// asynchronously: losing a write to a storage error must not stop an upload, it
// only costs the ability to resume that one file.

import { useSyncExternalStore } from 'react';
import type { QueueRecord, QueueStatus } from './types';
import { uploadedBytes } from './types';
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
type Ledger = { totalBytes: number; resolvedBytes: number };
let ledger: Ledger = { totalBytes: 0, resolvedBytes: 0 };

function resetLedger() {
  ledger = { totalBytes: 0, resolvedBytes: 0 };
}

/**
 * Empty queue means a fresh batch starts at zero.
 *
 * Without this the ledger keeps the previous batch's totals forever, so a new
 * batch would open with the bar already part-filled from work that is no longer
 * on screen.
 */
function resetLedgerWhenEmpty() {
  if (records.size === 0) {
    resetLedger();
    published = 0;
    // The next batch must start from zero, so the bar cannot keep showing the
    // previous batch's totals.
    refreshSummary();
  }
}

function publish() {
  // Insertion order is the order files were added. Sorting by updatedAt would
  // reshuffle rows on every progress tick.
  snapshot = [...records.values()].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  for (const listener of listeners) listener();
  // Anything structural (a row arrived, left, or changed phase) also changes the
  // bar's counts. A plain progress tick does not publish and does not land here.
  signalSummary();
}

export function getCompletedTick(): number {
  return completedTick;
}

// ---------------------------------------------------------------------------
// The batch summary, on its own clock
//
// The progress bar is the only part of the page that legitimately changes every
// few hundred milliseconds. Giving it a separate subscription means a part
// landing re-renders one component instead of the list, and the bar can be the
// one that is allowed to be a little behind.
//
// `published` and `resolved` are the stable halves of the denominator: rows are
// deleted on completion, so "total" cannot be read from the visible list. They
// are bumped at enqueue and when a batch empties, not per progress tick.
// ---------------------------------------------------------------------------

export type Summary = {
  /** Rows on the page: everything not yet finished. */
  active: number;
  /** Files still being prepared (nothing sent yet). */
  preparing: number;
  uploading: number;
  failed: number;
  skipped: number;
  /** The batch's denominator: files added plus files already resolved earlier. */
  total: number;
  totalBytes: number;
  /** Bytes actually at the bucket: resolved rows plus live parts. */
  sent: number;
};

let published = 0;

const summaryListeners = new Set<() => void>();
let summarySnapshot: Summary = {
  active: 0, preparing: 0, uploading: 0, failed: 0, skipped: 0,
  total: 0, totalBytes: 0, sent: 0,
};

const UPLOADING: QueueStatus[] = ['uploading', 'deriving', 'completing'];

function computeSummary(): Summary {
  let active = 0, preparing = 0, uploading = 0, failed = 0, skipped = 0, moving = 0;
  for (const record of records.values()) {
    active += 1;
    // A skipped row is already counted in full in resolvedBytes, so adding the
    // parts it managed before the duplicate was found would push "sent" past
    // the total.
    if (record.status === 'skipped') skipped += 1;
    else if (record.status === 'failed') failed += 1;
    else if (UPLOADING.includes(record.status)) { uploading += 1; moving += uploadedBytes(record); }
    else { preparing += 1; moving += uploadedBytes(record); }
  }
  return {
    active, preparing, uploading, failed, skipped,
    total: published,
    totalBytes: ledger.totalBytes,
    sent: ledger.resolvedBytes + moving,
  };
}

/**
 * Recompute the summary and keep the old object when nothing changed.
 *
 * Two separate problems are solved by this one rule:
 *
 *   1. useSyncExternalStore calls the snapshot reader on every render and
 *      treats a new object as a change. A reader that builds an object each
 *      time spins React into an infinite update loop, so the reader must return
 *      a stable reference — it returns `summarySnapshot` and never computes.
 *   2. Even here, notifying a listener with an identical summary would make the
 *      bar re-render for nothing. Reusing the old object when every field is
 *      equal means "same numbers" and "same reference" always agree.
 */
function refreshSummary(): boolean {
  const next = computeSummary();
  const previous = summarySnapshot;
  const unchanged = previous.active === next.active
    && previous.preparing === next.preparing
    && previous.uploading === next.uploading
    && previous.failed === next.failed
    && previous.skipped === next.skipped
    && previous.total === next.total
    && previous.totalBytes === next.totalBytes
    && previous.sent === next.sent;
  if (unchanged) return false;
  summarySnapshot = next;
  return true;
}

/**
 * Tell the bar the numbers may have moved.
 *
 * Recomputation happens here, once, and listeners are notified afterwards — and
 * only if the numbers really moved, so a status change that does not affect the
 * bar cannot make it render.
 */
export function signalSummary() {
  if (!refreshSummary()) return;
  for (const listener of summaryListeners) listener();
}

export function getSummary(): Summary {
  return summarySnapshot;
}

function subscribeSummary(listener: () => void): () => void {
  // The first subscriber can arrive mid-batch, so make sure the cache is warm
  // before React reads it.
  refreshSummary();
  summaryListeners.add(listener);
  return () => { summaryListeners.delete(listener); };
}

export function useSummary(): Summary {
  return useSyncExternalStore(subscribeSummary, getSummary, getSummary);
}

/**
 * A read without subscribing. Handy in tests, and it is the same object React
 * sees, so a test can assert on the numbers the bar would show.
 */
export function peekSummary(): Summary {
  return summarySnapshot;
}

/**
 * The shell badge's number, and nothing else.
 *
 * The shell is the ancestor of every page, so whatever it subscribes to decides
 * whether the page below it re-renders. Subscribing to the record list there made
 * a 300-photo import re-render the whole shell 300+ times: the photo grid was
 * thrown away and every thumbnail had to be fetched again.
 *
 * A number has the property this needs: Object.is on two equal numbers is true,
 * so a re-read that produced the same count is not a change and React skips the
 * render. Nothing is cached here because the value itself is the cache.
 */
function countActive(): number {
  let count = 0;
  for (const record of records.values()) {
    if (record.status !== 'skipped' && record.status !== 'failed') count += 1;
  }
  return count;
}

function subscribeActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActiveQueueCount(): number {
  return useSyncExternalStore(subscribeActive, countActive, countActive);
}

/**
 * The completion counter, published at most once a second.
 *
 * Every finished file bumps the raw counter, but the pages that listen to it (the
 * photo library) refetch from the server, and doing that per photo turned a
 * 300-photo import into 300 rounds of album + photo queries. One refresh per
 * second is indistinguishable to a person and collapses that to a handful.
 */
let publishedCompleted = 0;
let completedTimer: ReturnType<typeof setTimeout> | null = null;

function publishCompleted() {
  completedTimer = null;
  if (publishedCompleted === completedTick) return;
  publishedCompleted = completedTick;
  for (const listener of tickListeners) listener();
}

export function getCompletedPulse(): number {
  return publishedCompleted;
}

function subscribeCompleted(listener: () => void): () => void {
  tickListeners.add(listener);
  return () => { tickListeners.delete(listener); };
}

export function useCompletedTick(): number {
  return useSyncExternalStore(subscribeCompleted, getCompletedPulse, getCompletedPulse);
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
  published += batch.length;
  for (const record of batch) ledger.totalBytes += record.size;
  publish();
  await putRecords(batch);
}

/**
 * Merge a partial change into one record.
 *
 * Returns the updated record so the runner can keep working with the freshest
 * copy instead of a stale closure.
 *
 * `quiet` skips the React notification. Progress ticks need the bytes on disk
 * (that is the whole resume story) but not a render: a 40-part file used to
 * publish 40 whole-list snapshots, and each one handed every row a brand new
 * object, so the browser re-decoded the thumbnails. The bar gets those bytes
 * through its own slow subscription instead — see `useSummary`.
 */
export async function patchRecord(id: string, changes: Partial<QueueRecord>, options: { quiet?: boolean } = {}): Promise<QueueRecord | undefined> {
  const current = records.get(id);
  if (!current) return undefined;
  const next: QueueRecord = { ...current, ...changes, updatedAt: Date.now() };
  records.set(id, next);
  if (!options.quiet) publish();
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
    published = Math.max(0, published - 1);
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
  // Coalesced to one refresh a second: the listeners refetch from the server and
  // a 300-photo import must not become 300 rounds of queries.
  if (completedTimer === null) completedTimer = setTimeout(publishCompleted, 1000);
  const record = records.get(id);
  if (record) {
    // Only count bytes not already accounted for: a record that uploaded some
    // parts and was then dropped must not be added on top of those parts.
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
  if (record) ledger.resolvedBytes += record.size;
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
  published = 0;
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
    published += 1;
    ledger.totalBytes += record.size;
    if (status === 'skipped') {
      ledger.resolvedBytes += record.size;
    }
  }
  publish();
  return snapshot;
}

/** Test hook: drop everything from memory without touching storage. */
export function resetMemory(): void {
  records.clear();
  published = 0;
  completedTick = 0;
  publishedCompleted = 0;
  if (completedTimer !== null) { clearTimeout(completedTimer); completedTimer = null; }
  publish();
}
