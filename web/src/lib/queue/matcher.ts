// Matching, in both directions.
//
// Down: a queue record has to find its file again in a source the user just
// re-attached. Up: a local record has to adopt the server-side session that was
// left open, so a resumed upload continues instead of starting a new one.

import type { PendingUpload } from '../api';
import type { QueueRecord } from './types';
import type { SourceEntry } from './source';

export type EntryMatch = {
  entry: SourceEntry;
  /**
   * True when name, size and mtime all agree: the file is certainly the same one.
   * False means name and size agree but the timestamp differs, which is normal
   * for a file re-exported through a mobile photo library. Such a match is only
   * safe after the caller confirms it with a hash.
   */
  exact: boolean;
};

/**
 * Find the local file a record refers to.
 *
 * Timestamp is treated as a hint rather than an identity. iOS hands back files
 * whose lastModified is the export time, so requiring it would make resume
 * impossible there; ignoring a name+size coincidence would risk resuming into
 * the wrong photo. `exact: false` is therefore "verify by hash first".
 */
export function matchEntry(record: Pick<QueueRecord, 'name' | 'size' | 'mtime'>, entries: SourceEntry[]): EntryMatch | null {
  let fallback: EntryMatch | null = null;
  for (const entry of entries) {
    if (entry.name !== record.name || entry.size !== record.size) continue;
    if (entry.mtime === record.mtime) return { entry, exact: true };
    if (!fallback) fallback = { entry, exact: false };
  }
  return fallback;
}

/** The server-side session this record should adopt, if it was left open. */
export function matchPending(record: Pick<QueueRecord, 'name' | 'size' | 'mtime'>, pending: PendingUpload[]): PendingUpload | null {
  let fallback: PendingUpload | null = null;
  for (const item of pending) {
    if (item.name !== record.name || item.size !== record.size) continue;
    if (item.client_mtime === record.mtime) return item;
    if (!fallback && item.client_mtime === 0) fallback = item;
  }
  return fallback;
}

/**
 * Reverse lookup used when a local record is missing entirely: the server knows
 * about a session this browser started, so rebuild a record for it instead of
 * silently leaking the parts already uploaded.
 */
export function pendingToRecord(pending: PendingUpload, sessionId: string): QueueRecord {
  const now = Date.now();
  return {
    id: pending.id,
    sessionId,
    albumId: pending.album_id,
    name: pending.name,
    size: pending.size,
    mtime: pending.client_mtime,
    mime: pending.mime,
    sourceKey: `${pending.name}|${pending.size}|${pending.client_mtime}`,
    uploadId: pending.multipart ? pending.id : undefined,
    key: pending.key,
    hash: pending.content_hash || undefined,
    parts: [],
    takenAt: pending.taken_at || undefined,
    status: 'waiting',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}
