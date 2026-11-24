// The upload runner: a concurrency pool over the persisted queue.
//
// It replaces the old "hash everything, then upload one at a time" flow with a
// per-file pipeline. Two properties matter:
//
//   1. The time until the first byte is uploaded does not depend on the batch
//      size. File 900 is still queued while file 1 is transferring.
//   2. Every completed step is persisted before the next one starts, so a
//      refresh costs at most one part (8 MiB by default).

import { api, ApiError } from '../api';
import type { ExistingPhoto, UploadGrant } from '../api';
import { uploadParts as listServerParts, resignUpload, pendingUploads } from '../api';
import { checkDuplicates, buildDerivatives, createSession, sendOriginal, sendDerivatives, completeSession } from '../upload';
import type { DerivativeBlobs, TransferredPart } from '../upload';
import { resolveMime, SUPPORTED_MIME } from '../decode';
import { captureTimeOf } from '../exif';
import { hashOne } from '../hash';
import { translate, currentLocale } from '../i18n';
import * as store from './store';
import type { QueueRecord } from './types';
import { entryKey, type SourceEntry, type UploadSource } from './source';
import { matchEntry } from './matcher';

const t = (key: string, vars?: Record<string, string | number>) => translate(currentLocale(), key, vars);

/** Phones get one file at a time: three concurrent decodes exhausts the tab. */
export function concurrency(): number {
  if (typeof matchMedia !== 'function') return 3;
  return matchMedia('(pointer: coarse)').matches ? 1 : 3;
}

/** A soft single-batch cap on phones, where a long batch is killed anyway. */
export const MOBILE_MAX_FILES = 100;
export const MOBILE_MAX_BYTES = 500 * 1024 * 1024;

export function mobileLimit(entries: { size: number }[]): 'ok' | 'files' | 'bytes' {
  if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return 'ok';
  if (entries.length > MOBILE_MAX_FILES) return 'files';
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  return bytes > MOBILE_MAX_BYTES ? 'bytes' : 'ok';
}

// ---------------------------------------------------------------------------
// Source registry
//
// Sources hold Files and directory handles, neither of which can be persisted
// here: files would blow the quota and handles need re-permission anyway. They
// live in memory for the lifetime of the page, and `hydrate` marks anything it
// cannot resolve as `waiting` so the UI can ask for the folder again.
// ---------------------------------------------------------------------------

type SessionSource = { source: UploadSource; entries: SourceEntry[]; byKey: Map<string, SourceEntry> };

const sessions = new Map<string, SessionSource>();

function registerSource(sessionId: string, source: UploadSource, entries: SourceEntry[]) {
  const byKey = new Map<string, SourceEntry>();
  for (const entry of entries) byKey.set(entryKey(entry.name, entry.size, entry.mtime, entry.path), entry);
  sessions.set(sessionId, { source, entries, byKey });
}

export function sourceFor(sessionId: string): UploadSource | null {
  return sessions.get(sessionId)?.source ?? null;
}

/**
 * Rebuild a session's source list after the user re-attached its folder, and
 * give anything that was waiting on it another chance.
 *
 * This is the whole resume story for a reloaded page: the records survived, the
 * files did not, so the user points at the folder once and the queue continues.
 */
export async function rebindSource(sessionId: string, source: UploadSource, entries: SourceEntry[]): Promise<void> {
  registerSource(sessionId, source, entries);
  for (const record of store.recordsForSession(sessionId)) {
    if (record.status !== 'waiting') continue;
    if (!matchEntry(record, entries)) continue;
    await store.setStatus(record.id, 'queued');
  }
  void pump();
}

/**
 * Create one record per entry and start working through them.
 *
 * The records are written before any transfer begins, so a tab closed a second
 * later still leaves a resumable queue behind.
 */
export async function enqueue(sessionId: string, albumId: string, source: UploadSource, entries: SourceEntry[]): Promise<QueueRecord[]> {
  registerSource(sessionId, source, entries);
  const now = Date.now();
  const created: QueueRecord[] = entries.map((entry, index) => ({
    // Distinguishable rather than random ids: a stable ordering survives a sort.
    id: crypto.randomUUID(),
    sessionId,
    albumId,
    name: entry.name,
    size: entry.size,
    mtime: entry.mtime,
    mime: '',
    sourceKey: entryKey(entry.name, entry.size, entry.mtime, entry.path),
    parts: [],
    status: 'queued' as const,
    attempts: 0,
    createdAt: now + index,
    updatedAt: now,
  }));
  // One transaction, one publish: a 1000-file batch must not cost 1000 renders.
  await store.upsertRecords(created);
  void pump();
  return created;
}

/** Convenience for `<input type="file" multiple>`. */
export async function addFiles(albumId: string, files: File[]): Promise<QueueRecord[]> {
  const source = newFileSource(files);
  const entries = await source.list();
  return enqueue(crypto.randomUUID(), albumId, source, entries);
}

function newFileSource(files: File[]): UploadSource {
  // Imported lazily to keep this module free of a hard dependency on the DOM at
  // load time; the class is a thin wrapper over the array.
  return {
    kind: 'files',
    resumable: false,
    async list() {
      return files.map(file => ({ name: file.name, size: file.size, mtime: file.lastModified, file }));
    },
    async open(entry) {
      if (!entry.file) throw new Error('missing file');
      return entry.file;
    },
  };
}

// ---------------------------------------------------------------------------
// Duplicate checks, batched.
//
// The server rejects a check with more than 200 hashes, and one request per file
// would be 1000 round trips. Hashing and checking therefore ride a small window
// that flushes on size or on a short delay.
// ---------------------------------------------------------------------------

const CHECK_BATCH = 50;
const CHECK_DELAY = 400;

type Settle = (found: ExistingPhoto | null | Error) => void;
/**
 * Several records can share a hash: the same photo picked twice in one batch, or
 * two byte-identical files with different names. Each needs its own resolver, so
 * the value is a list rather than a single callback — keying by hash alone would
 * let the second record overwrite the first and hang it forever.
 */
type Waiters = Map<string, Settle[]>;

class DuplicateWindow {
  private groups = new Map<string, Waiters>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  ask(albumId: string, hash: string): Promise<ExistingPhoto | null> {
    return new Promise((resolve, reject) => {
      let group = this.groups.get(albumId);
      if (!group) {
        group = new Map();
        this.groups.set(albumId, group);
      }
      const settle: Settle = found => (found instanceof Error ? reject(found) : resolve(found));
      const waiters = group.get(hash);
      if (waiters) waiters.push(settle);
      else group.set(hash, [settle]);
      if (group.size >= CHECK_BATCH) void this.flush();
      else this.schedule();
    });
  }

  private schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, CHECK_DELAY);
  }

  private async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const batch = [...this.groups.entries()];
    this.groups.clear();
    if (!batch.length) return;
    await Promise.all(batch.map(async ([albumId, waiters]) => {
      try {
        const result = await checkDuplicates(albumId, [...waiters.keys()]);
        for (const [hash, resolvers] of waiters) {
          for (const resolve of resolvers) resolve(result.duplicates[hash] ?? null);
        }
      } catch (error) {
        // Fail every waiter in this group so their records retry rather than
        // hang. A duplicate check is advisory; a failure must not lose the file.
        const reason = error instanceof Error ? error : new Error(t('upload.checkFailed'));
        for (const resolvers of waiters.values()) {
          for (const resolve of resolvers) resolve(reason);
        }
      }
    }));
  }
}

const duplicates = new DuplicateWindow();

/**
 * Hashes this page has already put into the queue as real uploads.
 *
 * A folder of copies (the same photo saved eight times under different names) has
 * one hash but eight records. The server-side check answers "not in the album" for
 * all of them at once, so without this they would all start uploading the same
 * bytes and lose the race against each other inside the album's unique index — the
 * user would see "failed" for files that are simply duplicates of the first.
 */
const claimed = new Map<string, string>();

function batchKey(albumId: string, hash: string): string {
  return albumId + ':' + hash;
}

/**
 * Forget the batch's claims once everything has settled.
 *
 * Claims exist to stop two records in one batch from uploading the same bytes.
 * Keeping them past the batch would wrongly skip the same photo if the user
 * deleted it and added it again in a later session.
 */
function releaseClaimsWhenIdle(): void {
  if (store.getQueue().length === 0) claimed.clear();
}

/** Test hook: drop the batch state that spans records. */
export function resetRunnerState(): void {
  claimed.clear();
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BACKOFF = [1000, 4000, 10000];

const inFlight = new Set<string>();
let paused = false;
let pumping = false;
let leader: boolean | null = null;

export function pause(): void { paused = true; }
export function resume(): void { paused = false; void pump(); }
export function isPaused(): boolean { return paused; }

export function retry(id: string): void {
  void store.patchRecord(id, { status: 'queued', attempts: 0, error: undefined }).then(() => pump());
}

export async function cancel(id: string): Promise<void> {
  const record = store.getRecord(id);
  await store.removeRecord(id);
  releasePreview(id);
  if (record?.uploadId) {
    // Frees the parts in the bucket; the sweeper would eventually do the same,
    // but the user asked for it now.
    await api<void>(`/uploads/${record.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

/**
 * Only one tab may run the queue, otherwise two tabs upload the same files and
 * download the same parts twice.
 */
async function ensureLeader(): Promise<boolean> {
  if (leader !== null) return leader;
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks) {
    leader = true;
    return true;
  }
  leader = false;
  void locks.request('gallery-upload-leader', { ifAvailable: true }, async lock => {
    if (!lock) return;
    leader = true;
    void pump();
    // Hold the lock for the lifetime of the page.
    await new Promise<void>(() => undefined);
  }).catch(() => { leader = true; void pump(); });
  // The request settles on the next task; give it a chance before giving up.
  await new Promise(resolve => setTimeout(resolve, 0));
  return leader;
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    if (paused) return;
    if (!(await ensureLeader())) return;
    if (paused) return;
    const limit = concurrency();
    while (inFlight.size < limit) {
      const next = store.pendingRecords().find(record => !inFlight.has(record.id));
      if (!next) return;
      inFlight.add(next.id);
      void attempt(next).finally(() => {
        inFlight.delete(next.id);
        void pump();
      });
    }
  } finally {
    pumping = false;
  }
}

/** Start whatever survived a reload. Safe to call more than once. */
export async function start(): Promise<void> {
  await store.hydrate();
  await reconcile();
  void pump();
}

/**
 * Drop local rows whose server session is gone.
 *
 * A reloaded page keeps records but not the files behind them, so every one of
 * them looks resumable. Some are not: the worker aborts uploads after
 * STALE_UPLOAD_RETENTION, and once that happens there is nothing left to resume.
 * Without this check those rows sit in "waiting" forever, asking the user to pick
 * a folder that would only produce a conflict.
 *
 * A record with no session yet is kept: those are files that never got as far as
 * creating one, and re-attaching the folder still makes them uploadable.
 */
async function reconcile(): Promise<void> {
  const tracked = store.getQueue().filter(record => record.uploadId);
  if (!tracked.length) return;
  let alive: Set<string>;
  try {
    const pending = await pendingUploads();
    alive = new Set(pending.items.map(item => item.id));
  } catch {
    // Offline or the endpoint failed: keep local state rather than deleting work.
    return;
  }
  for (const record of tracked) {
    if (record.uploadId && alive.has(record.uploadId)) continue;
    releasePreview(record.id);
    await store.removeRecord(record.id);
  }
}

// ---------------------------------------------------------------------------
// Thumbnails for the queue rows
//
// Opening the file again is metadata-cheap, and an object URL is far cheaper
// than copying a preview into IndexedDB. URLs are cached per record and revoked
// by the row that created them, so a collapsed group never holds a reference.
// ---------------------------------------------------------------------------

/** Formats an `<img>` can actually paint. HEIC is not one of them. */
const PAINTABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const previews = new Map<string, string>();

export async function previewUrl(record: QueueRecord): Promise<string | null> {
  const cached = previews.get(record.id);
  if (cached) return cached;
  const session = sessions.get(record.sessionId);
  if (!session) return null;
  const entry = session.byKey.get(record.sourceKey) ?? matchEntry(record, session.entries)?.entry;
  if (!entry) return null;
  try {
    const file = await session.source.open(entry);
    if (!PAINTABLE.includes(file.type.toLowerCase())) return null;
    const url = URL.createObjectURL(file);
    previews.set(record.id, url);
    return url;
  } catch {
    return null;
  }
}

export function releasePreview(id: string): void {
  const url = previews.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  previews.delete(id);
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    // 4xx means the request itself is wrong: retrying changes nothing.
    if (error.status === 408 || error.status === 429) return true;
    return error.status >= 500;
  }
  return true;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return t('queue.failedGeneric');
}

async function attempt(record: QueueRecord): Promise<void> {
  for (let tries = 1; ; tries++) {
    const current = store.getRecord(record.id);
    if (!current) return;
    try {
      await processRecord(current);
      return;
    } catch (error) {
      // The album already holds these bytes: another upload won the race between
      // the pre-check and this request. That is a duplicate, not a failure.
      if (error instanceof ApiError && error.code === 'DUPLICATE_PHOTO') {
        // Release the claim so a later retry of the same bytes can proceed if the
        // user deletes the winner.
        if (current.hash) claimed.delete(batchKey(current.albumId, current.hash));
        await store.skipRecord(record.id);
        releaseClaimsWhenIdle();
        return;
      }
      const message = describe(error);
      const giveUp = tries >= MAX_ATTEMPTS || !isRetryable(error);
      if (current.hash) claimed.delete(batchKey(current.albumId, current.hash));
      await store.patchRecord(record.id, { status: giveUp ? 'failed' : 'queued', attempts: tries, error: message });
      if (giveUp) return;
      await new Promise(resolve => setTimeout(resolve, BACKOFF[tries - 1] ?? 10000));
    }
  }
}

/** A part is persisted as soon as the bucket accepts it. */
let persistChain: Promise<unknown> = Promise.resolve();
function persistPart(id: string, part: TransferredPart): void {
  persistChain = persistChain.then(async () => {
    const current = store.getRecord(id);
    if (!current) return;
    // Re-read each time so two parts finishing out of order cannot drop one.
    await store.patchRecord(id, { parts: [...current.parts, { n: part.n, size: part.size, etag: part.etag }] });
  }).catch(() => undefined);
}

async function processRecord(record: QueueRecord): Promise<void> {
  const session = sessions.get(record.sessionId);
  if (!session) {
    // The page that knew how to read these files is gone.
    await store.setStatus(record.id, 'waiting');
    return;
  }
  const entry = session.byKey.get(record.sourceKey) ?? matchEntry(record, session.entries)?.entry;
  if (!entry) {
    await store.setStatus(record.id, 'waiting');
    return;
  }
  const file = await session.source.open(entry);
  const mime = record.mime || resolveMime(file);
  if (!SUPPORTED_MIME.includes(mime)) throw new Error(t('upload.unsupportedType'));

  // 1. Hash. Kept inside the pipeline so the batch does not have to finish
  //    hashing before the first upload starts.
  let current = record;
  if (!current.hash) {
    current = (await store.setStatus(current.id, 'hashing')) ?? current;
    const hash = await hashOne(file);
    current = (await store.patchRecord(current.id, { hash, mime })) ?? current;
  }

  // 2. Duplicate check. Cheap, and skipped uploads save the whole transfer.
  const existing = await duplicates.ask(current.albumId, current.hash!);
  if (existing) {
    // Counted as resolved: the album already holds these bytes, so the file needs
    // no further work and the shared progress bar can advance past it.
    await store.skipRecord(current.id);
    releaseClaimsWhenIdle();
    return;
  }
  // Another record in this batch is already uploading the same bytes.
  const claim = batchKey(current.albumId, current.hash!);
  const owner = claimed.get(claim);
  if (owner && owner !== current.id) {
    await store.skipRecord(current.id);
    releaseClaimsWhenIdle();
    return;
  }
  claimed.set(claim, current.id);

  // 3. Open a session, or adopt the one a previous visit left behind.
  let grant: UploadGrant;
  let blobs: DerivativeBlobs | null = null;
  current = (await store.setStatus(current.id, 'creating')) ?? current;
  if (!current.uploadId) {
    blobs = await buildDerivatives(file);
    const takenAt = current.takenAt ?? ((await captureTimeOf(file)) || '');
    grant = await createSession({
      albumID: current.albumId,
      name: file.name,
      size: file.size,
      mime,
      width: blobs.width,
      height: blobs.height,
      contentHash: current.hash,
      takenAt,
      clientMtime: file.lastModified,
    });
    current = (await store.patchRecord(current.id, {
      uploadId: grant.id, key: grant.key, width: blobs.width, height: blobs.height, takenAt, mime,
    })) ?? current;
  } else {
    // Signatures expire (15 minutes by default) and the local part list may be
    // stale, so both are refreshed from the server before resuming.
    try {
      grant = await resignUpload(current.uploadId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UPLOAD_EXPIRED') {
        // The sweeper reclaimed it. Start over rather than fail the file.
        current = (await store.patchRecord(current.id, { uploadId: undefined, key: undefined, parts: [] })) ?? current;
        throw new Error(t('upload.expired'));
      }
      throw error;
    }
    const listed = await listServerParts(current.uploadId);
    current = (await store.patchRecord(current.id, {
      parts: listed.parts.map(part => ({ n: part.part_number, size: part.size, etag: part.etag })),
    })) ?? current;
  }

  // 4. Original bytes. Already-transferred parts are skipped.
  current = (await store.setStatus(current.id, 'uploading')) ?? current;
  await sendOriginal(file, grant, {
    skip: current.parts.map(part => part.n),
    onPart: part => persistPart(current.id, part),
  });
  await persistChain;

  // 5. Thumbnail and preview. Only rebuilt when a previous attempt did not
  //    finish them, so a resumed file is not decoded twice.
  current = store.getRecord(current.id) ?? current;
  if (!current.derivativesDone) {
    current = (await store.setStatus(current.id, 'deriving')) ?? current;
    blobs = blobs ?? await buildDerivatives(file);
    await sendDerivatives(grant, blobs);
    current = (await store.patchRecord(current.id, { derivativesDone: true })) ?? current;
  }

  // 6. Complete. The server lists the parts itself, so this is idempotent.
  current = (await store.setStatus(current.id, 'completing')) ?? current;
  await completeSession(grant);
  // A finished row leaves the page: the queue is a work list, and keeping
  // completed rows would push the ones that still need attention off screen.
  releasePreview(current.id);
  await store.finishRecord(current.id);
  releaseClaimsWhenIdle();
}
