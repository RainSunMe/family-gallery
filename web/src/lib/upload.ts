import { translate, currentLocale } from './i18n';
import { api } from './api';
import type { UploadGrant } from './api';
import { getDisplayName } from './identity';

const t = (key: string, vars?: Record<string, string | number>) => translate(currentLocale(), key, vars);

export type UploadInput = { file: File; width: number; height: number; message?: string };
export type UploadProgress = (completed: number, total: number, label: string) => void;

async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  if (!file.type.startsWith('image/') || /heic|heif/i.test(file.type)) return { width: 0, height: 0 };
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch { return { width: 0, height: 0 }; }
  finally { URL.revokeObjectURL(url); }
}

async function derivative(file: File, width: number, height: number, max: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const scale = Math.min(1, max / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('upload.previewUnsupported'));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('upload.previewFailed'))), 'image/webp', .84));
  } finally { URL.revokeObjectURL(url); }
}

async function put(url: string, body: Blob): Promise<string> {
  const response = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': body.type || 'application/octet-stream' } });
  if (!response.ok) throw new Error(t('upload.s3Failed', { status: response.status }));
  return response.headers.get('ETag')?.replaceAll('"', '') || '';
}

export async function uploadPhoto(file: File, albumID: string, onProgress?: UploadProgress): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error(t('upload.unsupportedType'));
  if (file.size > 200 * 1024 * 1024) throw new Error(t('upload.tooLarge'));
  const { width, height } = await imageDimensions(file);
  if (!width || !height) throw new Error(t('upload.readDimensions'));
  const grant = await api<UploadGrant>('/uploads', { method: 'POST', body: JSON.stringify({ album_id: albumID, name: file.name, size: file.size, mime: file.type, width, height, contributor: getDisplayName() }) });
  await transfer(file, grant, onProgress);
  const [thumb, preview] = await Promise.all([derivative(file, width, height, 480), derivative(file, width, height, 1600)]);
  await Promise.all([put(grant.thumb_url, thumb), put(grant.preview_url, preview)]);
  const result = await api<{ id: string }>(`/uploads/${grant.id}/complete`, { method: 'POST', body: JSON.stringify({ parts: completedParts(grant.id) }) });
  onProgress?.(1, 1, t('upload.done'));
  return result.id;
}

export async function uploadGuestPhoto(file: File, message: string, onProgress?: UploadProgress): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error(t('upload.pickPhoto'));
  const { width, height } = await imageDimensions(file);
  if (!width || !height) throw new Error(t('upload.readDimensionsShort'));
  const grant = await api<UploadGrant>('/guest/collections/uploads', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, width, height, message }) });
  await transfer(file, grant, onProgress);
  const [thumb, preview] = await Promise.all([derivative(file, width, height, 480), derivative(file, width, height, 1600)]);
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
