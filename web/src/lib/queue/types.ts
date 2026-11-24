// Types shared by the upload queue modules.
//
// A record is the durable description of one file in a batch. It deliberately
// holds no bytes: the file itself is re-read from its source (a directory handle
// or the File the user picked), which is what keeps 1000 photos inside the
// IndexedDB quota.

/**
 * Lifecycle of one file.
 *
 * `waiting` is the state after a reload: the record survived but the browser no
 * longer holds the file, so the user has to reattach the source before it can
 * continue. It is not an error.
 */
export type QueueStatus =
  | 'waiting'
  | 'queued'
  | 'hashing'
  | 'checking'
  | 'creating'
  | 'uploading'
  | 'deriving'
  | 'completing'
  | 'done'
  | 'skipped'
  | 'failed';

/** A transferred part. The size is what the byte progress line is built from. */
export type PartRef = { n: number; size: number; etag: string };

export type QueueRecord = {
  id: string;
  /** Batches are grouped so progress can be shown per "add photos" action. */
  sessionId: string;
  albumId: string;
  name: string;
  size: number;
  /** Browser file.lastModified in milliseconds, used to re-identify on resume. */
  mtime: number;
  mime: string;
  /** Key into the session's source registry; `name|size|mtime`. */
  sourceKey: string;
  uploadId?: string;
  key?: string;
  hash?: string;
  parts: PartRef[];
  /** Filled in during `creating`, so a resume does not decode the file again. */
  width?: number;
  height?: number;
  takenAt?: string;
  /** Set once the thumbnail and preview reached the bucket. */
  derivativesDone?: boolean;
  status: QueueStatus;
  attempts: number;
  error?: string;
  /** Fixed at enqueue time; the list is ordered by it. */
  createdAt: number;
  updatedAt: number;
};

/** Bytes already transferred, for the "5.1 MB / 7.3 MB" line. */
export function uploadedBytes(record: QueueRecord): number {
  let total = 0;
  for (const part of record.parts) total += part.size;
  return total;
}

/** Statuses that still need the runner to do something. */
export const ACTIVE_STATUSES: QueueStatus[] = ['queued', 'hashing', 'checking', 'creating', 'uploading', 'deriving', 'completing'];

export function isActive(record: QueueRecord): boolean {
  return ACTIVE_STATUSES.includes(record.status);
}

export function isFinished(record: QueueRecord): boolean {
  return record.status === 'done' || record.status === 'skipped';
}
