import { translate, currentLocale } from './i18n';
import { api } from './api';
import type { DuplicateCheck, UploadGrant } from './api';
import { getDisplayName } from './identity';
import { captureTimeOf } from './exif';
import { decodeImage, resolveMime, resizeToWebp, SUPPORTED_MIME } from './decode';

const t = (key: string, vars?: Record<string, string | number>) => translate(currentLocale(), key, vars);

export type UploadInput = { file: File; width: number; height: number; message?: string };
export type UploadProgress = (completed: number, total: number, label: string) => void;
export type UploadOptions = { contentHash?: string; allowDuplicate?: boolean };

/** Ask the server which of these hashes the album already contains. */
export async function checkDuplicates(albumID: string, hashes: string[]): Promise<DuplicateCheck> {
  if (!hashes.length) return { duplicates: {}, new: [], legacy_photos: 0 };
  return api<DuplicateCheck>('/uploads/check', { method: 'POST', body: JSON.stringify({ album_id: albumID, hashes }) });
}

async function derivatives(file: File): Promise<{ width: number; height: number; thumb: Blob; preview: Blob }> {
  // One decode, two sizes. Decoding per size meant a HEIC file was decoded twice,
  // which is the expensive part.
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
  return response.headers.get('ETag')?.replaceAll('"', '') || '';
}

export async function uploadPhoto(file: File, albumID: string, options: UploadOptions = {}, onProgress?: UploadProgress): Promise<string> {
  const mime = resolveMime(file);
  if (!SUPPORTED_MIME.includes(mime)) throw new Error(t('upload.unsupportedType'));
  if (file.size > 200 * 1024 * 1024) throw new Error(t('upload.tooLarge'));
  const { width, height, thumb, preview } = await derivatives(file);
  // The capture time comes from the file, so an album sorts by when the photo
  // was taken rather than by when it happened to be uploaded.
  const takenAt = await captureTimeOf(file);
  const grant = await api<UploadGrant>('/uploads', { method: 'POST', body: JSON.stringify({ album_id: albumID, name: file.name, size: file.size, mime, width, height, contributor: getDisplayName(), content_hash: options.contentHash || '', allow_duplicate: !!options.allowDuplicate, taken_at: takenAt || '' }) });
  await transfer(file, grant, onProgress);
  await Promise.all([put(grant.thumb_url, thumb), put(grant.preview_url, preview)]);
  const result = await api<{ id: string }>(`/uploads/${grant.id}/complete`, { method: 'POST', body: JSON.stringify({ parts: completedParts(grant.id) }) });
  onProgress?.(1, 1, t('upload.done'));
  return result.id;
}

export async function uploadGuestPhoto(file: File, message: string, options: UploadOptions = {}, onProgress?: UploadProgress): Promise<string> {
  const mime = resolveMime(file);
  if (!SUPPORTED_MIME.includes(mime)) throw new Error(t('upload.pickPhoto'));
  const { width, height, thumb, preview } = await derivatives(file);
  const takenAt = await captureTimeOf(file);
  const grant = await api<UploadGrant>('/guest/collections/uploads', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, mime, width, height, message, content_hash: options.contentHash || '', taken_at: takenAt || '' }) });
  await transfer(file, grant, onProgress);
  await Promise.all([put(grant.thumb_url, thumb), put(grant.preview_url, preview)]);
  const result = await api<{ id: string }>('/guest/collections/uploads/' + grant.id + '/complete', { method: 'POST', body: JSON.stringify({ parts: completedParts(grant.id) }) });
  return result.id;
}

async function transfer(file: File, grant: UploadGrant, onProgress?: UploadProgress) {
  if (!grant.multipart_upload_id) { await put(grant.url, file); return; }
  const partSize = grant.part_size || 8 * 1024 * 1024;
  const count = Math.ceil(file.size / partSize);
  const parts: { PartNumber: number; ETag: string }[] = [];
  for (let index = 0; index < count; index++) {
    const chunk = file.slice(index * partSize, Math.min(file.size, (index + 1) * partSize));
    const signed = await api<{ url: string }>(`${grant.key.startsWith('collections/') ? '/guest/collections' : ''}/uploads/${grant.id}/parts/sign`, { method: 'POST', body: JSON.stringify({ part_number: index + 1 }) });
    const etag = await put(signed.url, chunk);
    if (!etag) throw new Error(t('upload.missingEtag'));
    parts.push({ PartNumber: index + 1, ETag: etag });
    onProgress?.(index + 1, count, t('upload.partProgress', { index: index + 1, count }));
  }
  // The caller's completion request supplies these parts via this scoped payload.
  (grant as UploadGrant & { completedParts?: unknown }).completedParts = parts;
  pendingParts.set(grant.id, parts);
}
const pendingParts = new Map<string, { PartNumber: number; ETag: string }[]>();
export function completedParts(id: string) { return pendingParts.get(id) || []; }
