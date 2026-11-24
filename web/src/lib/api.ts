import { currentLocale, translate } from './i18n';
import { getDisplayName } from './identity';

export type Role = 'family' | 'admin';
export type Album = {
  id: string; name: string; description: string; cover_url: string; cover_photo_id: string;
  photo_count: number; shared: boolean; created_at: string; updated_at: string;
  taken_from: string; taken_to: string;
};
export type Photo = {
  id: string; album_id: string; name: string; mime: string; size: number;
  width: number; height: number; taken_at: string; contributor?: string; status?: string;
};
export type PhotoPage = { items: Photo[]; urls: Record<string, string>; next_cursor: string };
export type Contributor = { name: string; count: number };
export type CollectionPhoto = Photo & { url: string; contributor: string; created_at: string; message: string; status: 'pending' | 'imported' | 'duplicate' };
export type Collection = {
  id: string; name: string; description: string; album_id: string; status: 'active' | 'ended';
  expires_at: string; batch_limit: number; allow_message: boolean; created_at: string;
  photo_count: number; pending_count: number; imported_count: number; duplicate_count: number;
  contributors: Contributor[]; photos: CollectionPhoto[]; invite_url: string;
};
export type Share = { id: string; album_id: string; album_name: string; album_cover_url: string; photo_count: number; expires_at: string; created_at: string; view_count: number; url: string };
export type DownloadPackage = { id: string; part: number; size: string; file_count: number };
export type DownloadJob = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; progress: number; error: string; packages: DownloadPackage[]; expires_at: string };
export type UploadGrant = { id: string; key: string; url: string; thumb_url: string; preview_url: string; multipart_upload_id: string; part_size: number };
// A session the server still holds for this browser: it was started and never
// completed. Used to rebuild the upload queue after a refresh.
export type PendingUpload = {
  id: string; album_id: string; key: string; name: string; size: number; mime: string;
  content_hash: string; client_mtime: number; taken_at: string; multipart: boolean; created_at: string;
};
// A part the bucket already holds. The server is the authority here: the browser
// cannot be trusted to remember what it sent across a refresh.
export type UploadPart = { part_number: number; etag: string; size: number };
export type ExistingPhoto = { id: string; name: string; contributor: string; taken_at: string; thumb_url: string };
export type DuplicateCheck = { duplicates: Record<string, ExistingPhoto>; new: string[]; legacy_photos: number };
export type TrashItem = {
  id: string; album_id: string; album_name: string; album_deleted: boolean; name: string;
  size: number; width: number; height: number; contributor: string;
  deleted_by: string; deleted_at: string; thumb_url: string;
};
export type TrashPage = {
  items: TrashItem[]; next_cursor: string; total_count: number; total_bytes: number;
  retention_days: number; expires_at: string;
};

export class ApiError extends Error {
  // `details` carries the parsed error body so a caller can react to fields
  // beyond code/message, such as the photo a duplicate upload collided with.
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `/api/v1${path}${separator}lang=${currentLocale()}`;
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (!response.ok) {
    let message = translate(currentLocale(), 'api.requestFailed'); let code = 'REQUEST_FAILED'; let details: unknown;
    try { const data = await response.json(); message = data.error?.message || message; code = data.error?.code || code; details = data; } catch { /* non-json error */ }
    throw new ApiError(response.status, code, message, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const listAlbums = () => api<{ items: Album[] }>('/albums');
export const getAlbum = (id: string) => api<Album>(`/albums/${id}`);
export const listPhotos = (albumId = '', type = 'all') => api<PhotoPage>(`${albumId ? `/albums/${albumId}/photos` : '/photos'}${type !== 'all' ? `?type=${type}` : ''}`);
export const listCollections = () => api<{ items: Collection[] }>('/collections');
export const getCollection = (id: string) => api<Collection>(`/collections/${id}`);
export const listShares = () => api<{ items: Share[] }>('/shares');
export const createAlbum = (input: { name: string; description: string }) => api<Album>('/albums', { method: 'POST', body: JSON.stringify(input) });
export const setAlbumCover = (albumID: string, photoID: string) => api<Album>(`/albums/${albumID}/cover`, { method: 'PUT', body: JSON.stringify({ photo_id: photoID }) });
export const createCollection = (input: { name: string; description: string; album_id: string; expiry_days: number; batch_limit: number; allow_message: boolean }) => api<{ id: string; url: string }>('/collections', { method: 'POST', body: JSON.stringify(input) });
export const createShare = (input: { album_id: string; expiry_days: number }) => api<{ id: string; url: string }>('/shares', { method: 'POST', body: JSON.stringify(input) });
export const revokeShare = (id: string) => api<void>(`/shares/${id}`, { method: 'DELETE' });
export const closeCollection = (id: string) => api<{ status: string }>(`/collections/${id}/close`, { method: 'POST', body: '{}' });
export const importCollection = (id: string, itemIDs: string[] = []) => api<{ imported: number; failed: number; skipped_duplicates: number }>(`/collections/${id}/imports`, { method: 'POST', body: JSON.stringify({ item_ids: itemIDs }) });
export const createDownload = (input: { album_id: string; photo_ids: string[]; mode: 'single' | 'batch' }, guestToken = '') => api<{ id: string }>(`${guestToken ? `/guest/shares/${guestToken}` : ''}/downloads`, { method: 'POST', body: JSON.stringify(input) });
export const getDownload = (id: string, guestToken = '') => api<DownloadJob>(`${guestToken ? `/guest/shares/${guestToken}` : ''}/downloads/${id}`);
export const signDownload = (id: string, packageID: string, guestToken = '') => api<{ url: string }>(`${guestToken ? `/guest/shares/${guestToken}` : ''}/downloads/${id}/sign`, { method: 'POST', body: JSON.stringify({ package_id: packageID }) });
export const guestAlbum = (token: string) => api<Album>(`/guest/shares/${token}/album`);
export const guestPhotos = (token: string, albumID: string) => api<PhotoPage>(`/guest/shares/${token}/photos?album_id=${albumID}`);
export const guestCollection = () => api<{ id: string; name: string; description: string; expires_at: string; batch_limit: number; allow_message: boolean; display_name: string }>('/guest/collections/current');
export const guestSession = (token: string, displayName: string) => api<{ display_name: string }>(`/guest/collections/${token}/session`, { method: 'POST', body: JSON.stringify({ display_name: displayName }) });
export const guestSubmissions = () => api<{ items: { id: string; name: string; url: string; status: string; created_at: string }[] }>('/guest/collections/submissions');
export const listTrash = (cursor = '') => api<TrashPage>(`/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
export const trashPhotos = (ids: string[]) => api<{ trashed: number; batch: string }>('/photos/trash', { method: 'POST', body: JSON.stringify({ ids, by: getDisplayName() }) });
export const restorePhotos = (ids: string[]) => api<{ restored: number; albums_restored: number }>('/trash/restore', { method: 'POST', body: JSON.stringify({ ids }) });
export const emptyTrash = () => api<{ purged: number; failed: number }>('/trash', { method: 'DELETE' });
export const deleteAlbum = (id: string) => api<{ deleted: boolean; photos: number }>(`/albums/${id}`, { method: 'DELETE', body: JSON.stringify({ by: getDisplayName() }) });
export const signPhoto = (id: string, variant = 'original', guestToken = '', download = false) => guestToken.startsWith('collection:')
  ? api<{ url: string }>(`/collections/${guestToken.slice(11)}/sign-read`, { method: 'POST', body: JSON.stringify({ item_id: id, variant }) })
  : api<{ url: string }>(`${guestToken ? `/guest/shares/${guestToken}` : ''}/media/sign-read`, { method: 'POST', body: JSON.stringify({ photo_id: id, variant, download }) });

// Upload queue. `pendingUploads` is what makes the queue survive a refresh: the
// browser asks the server which sessions are still open instead of trusting its
// own memory.
export const pendingUploads = () => api<{ items: PendingUpload[] }>('/uploads/pending');
export const uploadParts = (id: string) => api<{ parts: UploadPart[]; part_size: number }>(`/uploads/${id}/parts/list`, { method: 'POST', body: '{}' });
export const resignUpload = (id: string) => api<UploadGrant>(`/uploads/${id}/resign`, { method: 'POST', body: '{}' });

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch { const field = document.createElement('textarea'); field.value = text; document.body.appendChild(field); field.select(); document.execCommand('copy'); field.remove(); }
}
export const formatDate = (value: string) => value ? new Intl.DateTimeFormat(currentLocale() === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value)) : '';
export const formatSize = (bytes: number) => bytes >= 1 << 20 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
