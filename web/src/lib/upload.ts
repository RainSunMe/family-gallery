import { translate, currentLocale } from './i18n';
import { api } from './api';
import type { DuplicateCheck, UploadGrant } from './api';
import { getDisplayName } from './identity';
import { captureTimeOf } from './exif';
import { decodeImage, decodeVideoFrame, isVideoMime, resolveMime, resizeToWebp, SUPPORTED_MIME } from './decode';

const t = (key: string, vars?: Record<string, string | number>) => translate(currentLocale(), key, vars);

export type UploadInput = { file: File; width: number; height: number; message?: string };
export type UploadProgress = (completed: number, total: number, label: string) => void;
export type UploadOptions = { contentHash?: string; allowDuplicate?: boolean };

/** A part the bucket accepted. `etag` may be empty when CORS hides it. */
export type TransferredPart = { n: number; etag: string; size: number };

export type DerivativeBlobs = { width: number; height: number; thumb: Blob; preview: Blob };

/** Ask the server which of these hashes the album already contains. */
export async function checkDuplicates(albumID: string, hashes: string[]): Promise<DuplicateCheck> {
  if (!hashes.length) return { duplicates: {}, new: [], legacy_photos: 0 };
  return api<DuplicateCheck>('/uploads/check', { method: 'POST', body: JSON.stringify({ album_id: albumID, hashes }) });
}

/**
 * Decode once, produce both sizes. The caller owns the blobs, which is what lets
 * the queue rebuild its own state and re-derive only on a fresh attempt.
 *
 * A video has no bitmap to decode: its cover is a frame painted onto a canvas,
 * so it goes through the same downscale step and lands in the bucket as the
 * same WebP pair a photo produces. No transcoding happens here — the original
 * MP4 is what the viewer plays.
 */
export async function buildDerivatives(file: File): Promise<DerivativeBlobs> {
  // One decode, two sizes. Decoding per size meant a HEIC file was decoded twice,
  // which is the expensive part.
  if (isVideoMime(resolveMime(file))) {
    // A 4K frame painted at full size would cost ~33 MB of canvas for pixels
    // that are immediately downscaled, so the cover is bounded here.
    const frame = await decodeVideoFrame(file, 1600);
    const [thumb, preview] = await Promise.all([resizeToWebp(frame, 480), resizeToWebp(frame, 1600)]);
    return { width: frame.width, height: frame.height, thumb, preview };
  }
  const decoded = await decodeImage(file);
  try {
    const [thumb, preview] = await Promise.all([resizeToWebp(decoded, 480), resizeToWebp(decoded, 1600)]);
    return { width: decoded.width, height: decoded.height, thumb, preview };
  } finally {
    decoded.release();
  }
}

async function put(url: string, body: Blob): Promise<string> {
  const response = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': body.type || 'application/octet-stream' } });
  if (!response.ok) throw new Error(t('upload.s3Failed', { status: response.status }));
  // The ETag is only local bookkeeping now: completion asks the server to list
  // the parts, so a CORS policy that hides the header no longer blocks an upload.
  return response.headers.get('ETag')?.replaceAll('"', '') || '';
}

/** PUT a single blob (a derivative). Exported so the runner can retry it alone. */
export async function putBlob(url: string, body: Blob): Promise<string> {
  return put(url, body);
}

function guestPrefix(grant: UploadGrant): string {
  return grant.key.startsWith('collections/') ? '/guest/collections' : '';
}

export type CreateSessionInput = {
  /** Omitted for a guest collection upload, which the server scopes itself. */
  albumID?: string;
  name: string;
  size: number;
  mime: string;
  width: number;
  height: number;
  contentHash?: string;
  allowDuplicate?: boolean;
  takenAt?: string;
  /** file.lastModified, so a resume can match this session to a local file. */
  clientMtime?: number;
  message?: string;
};

/** Open a server-side upload session and get presigned URLs back. */
export async function createSession(input: CreateSessionInput): Promise<UploadGrant> {
  const body = {
    album_id: input.albumID || '',
    name: input.name,
    size: input.size,
    mime: input.mime,
    width: input.width,
    height: input.height,
    message: input.message || '',
    contributor: getDisplayName(),
    content_hash: input.contentHash || '',
    allow_duplicate: !!input.allowDuplicate,
    taken_at: input.takenAt || '',
    client_mtime: input.clientMtime || 0,
  };
  const path = input.albumID === undefined ? '/guest/collections/uploads' : '/uploads';
  return api<UploadGrant>(path, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Parts of one file go up at once, up to this many.
 *
 * Serially was the reason a single 2 GiB video crawled: the line sat idle while
 * each part was signed and RTT-bound before the next chunk was even sliced. Three
 * in flight per file saturates a normal connection while staying inside the
 * browser's six-connections-per-host cap, which several files share.
 */
const PART_CONCURRENCY = 3;

/**
 * Upload the original, part by part.
 *
 * `skip` lets a resume avoid re-sending parts the bucket already holds, and
 * `onPart` fires after each successful PUT so the caller can persist progress
 * before the next part starts. That is the difference between losing one 8 MiB
 * chunk and losing the whole batch.
 *
 * Parts run in parallel but `onPart` is still called in the order they finish —
 * the caller appends, and appending in completion order is harmless because a
 * part list is a set keyed by number.
 */
export async function sendOriginal(
  file: File,
  grant: UploadGrant,
  options: { skip?: number[]; onPart?: (part: TransferredPart) => void; onProgress?: UploadProgress } = {},
): Promise<TransferredPart[]> {
  if (!grant.multipart_upload_id) {
    const etag = await put(grant.url, file);
    const part: TransferredPart = { n: 1, etag, size: file.size };
    options.onPart?.(part);
    options.onProgress?.(1, 1, t('upload.done'));
    return [part];
  }
  const partSize = grant.part_size || 8 * 1024 * 1024;
  const count = Math.ceil(file.size / partSize);
  const skip = new Set(options.skip || []);
  const pending: number[] = [];
  for (let index = 0; index < count; index++) if (!skip.has(index + 1)) pending.push(index + 1);

  const parts: TransferredPart[] = [];
  let finished = count - pending.length;
  let cursor = 0;

  const worker = async () => {
    while (cursor < pending.length) {
      const number = pending[cursor++];
      const index = number - 1;
      const start = index * partSize;
      const chunk = file.slice(start, Math.min(file.size, start + partSize));
      const signed = await api<{ url: string }>(`${guestPrefix(grant)}/uploads/${grant.id}/parts/sign`, { method: 'POST', body: JSON.stringify({ part_number: number }) });
      const etag = await put(signed.url, chunk);
      const part: TransferredPart = { n: number, etag, size: chunk.size };
      parts.push(part);
      finished += 1;
      options.onPart?.(part);
      options.onProgress?.(finished, count, t('upload.partProgress', { index: finished, count }));
    }
  };

  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, pending.length) }, worker));
  // Sorted so the returned list is stable regardless of which PUT finished first.
  return parts.sort((a, b) => a.n - b.n);
}

/** Upload the thumbnail and the preview. */
export async function sendDerivatives(grant: UploadGrant, blobs: DerivativeBlobs): Promise<void> {
  await Promise.all([put(grant.thumb_url, blobs.thumb), put(grant.preview_url, blobs.preview)]);
}

/**
 * Finish the session.
 *
 * The body is intentionally empty: the server lists the parts from the bucket and
 * completes with those. That makes completion idempotent and removes the old
 * dependency on an in-memory part map that a refresh destroyed.
 */
export async function completeSession(grant: UploadGrant): Promise<string> {
  const result = await api<{ id: string }>(`${guestPrefix(grant)}/uploads/${grant.id}/complete`, { method: 'POST', body: '{}' });
  return result.id;
}

export async function uploadPhoto(file: File, albumID: string, options: UploadOptions = {}, onProgress?: UploadProgress): Promise<string> {
  const mime = resolveMime(file);
  if (!SUPPORTED_MIME.includes(mime)) throw new Error(t('upload.unsupportedType'));
  if (file.size > 200 * 1024 * 1024) throw new Error(t('upload.tooLarge'));
  const blobs = await buildDerivatives(file);
  // The capture time comes from the file, so an album sorts by when the photo
  // was taken rather than by when it happened to be uploaded.
  const takenAt = await captureTimeOf(file);
  const grant = await createSession({
    albumID, name: file.name, size: file.size, mime, width: blobs.width, height: blobs.height,
    contentHash: options.contentHash, allowDuplicate: options.allowDuplicate,
    takenAt: takenAt || '', clientMtime: file.lastModified,
  });
  await sendOriginal(file, grant, { onProgress });
  await sendDerivatives(grant, blobs);
  const id = await completeSession(grant);
  onProgress?.(1, 1, t('upload.done'));
  return id;
}

export async function uploadGuestPhoto(file: File, message: string, options: UploadOptions = {}, onProgress?: UploadProgress): Promise<string> {
  const mime = resolveMime(file);
  if (!SUPPORTED_MIME.includes(mime)) throw new Error(t('upload.pickPhoto'));
  const blobs = await buildDerivatives(file);
  const takenAt = await captureTimeOf(file);
  const grant = await createSession({
    name: file.name, size: file.size, mime, width: blobs.width, height: blobs.height,
    contentHash: options.contentHash, takenAt: takenAt || '', clientMtime: file.lastModified, message,
  });
  await sendOriginal(file, grant, { onProgress });
  await sendDerivatives(grant, blobs);
  return completeSession(grant);
}
