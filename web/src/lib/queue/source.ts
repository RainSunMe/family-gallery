// Input sources for the upload queue.
//
// Three browser capabilities exist, with different powers:
//
//   showDirectoryPicker   Chromium only, but the handle is persistable, so a
//                         resume needs one permission click instead of picking
//                         the files again.
//   input webkitdirectory everywhere modern, but the selection cannot be
//                         persisted: a resume asks the user to re-pick, and the
//                         files are matched by name+size+mtime.
//   input multiple        the fallback, and the only option inside the WeChat
//                         webview.
//
// The pipeline downstream never learns which one it got: it only needs "list the
// entries" and "give me the bytes for this one".

import { putHandle, getHandle } from './db';

/** The slice of the File System Access API this app uses. */
type DirectoryHandle = {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterableIterator<DirectoryEntry>;
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
};

type FileEntry = { readonly kind: 'file'; readonly name: string; getFile(): Promise<File> };
type DirectoryEntry = FileEntry | DirectoryHandle;

type PickerWindow = Window & { showDirectoryPicker?: (options?: { id?: string; mode?: 'read' }) => Promise<DirectoryHandle> };

export const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'mp4'];

/** Formats the browser can paint in a thumbnail without decoding through wasm. */
const PREVIEWABLE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

/** Video needs a decoder that pulls a frame, not an `<img>`. */
const VIDEO_EXTENSIONS = ['mp4'];

/** A folder walk is stopped at these limits so a huge library cannot freeze the tab. */
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 12;
const IGNORED_DIRECTORIES = ['node_modules', '.git', '.thumbnails', 'thumbnails', '@eadir', '#recycle', 'system volume information', '$recycle.bin'];

export type SourceEntry = {
  name: string;
  /**
   * Path relative to the folder the user picked, `/`-separated. Equal to `name`
   * for a flat selection. It is what makes two `IMG_0001.JPG` from different
   * subfolders distinct.
   */
  path?: string;
  size: number;
  /** Milliseconds. Unreliable for files re-exported from a mobile photo library. */
  mtime: number;
  file?: File;
  handle?: FileEntry;
};

export type SourceKind = 'directory' | 'picker-directory' | 'files';

export interface UploadSource {
  readonly kind: SourceKind;
  /** Whether a resume can recover the bytes without the user picking again. */
  readonly resumable: boolean;
  list(): Promise<SourceEntry[]>;
  open(entry: SourceEntry): Promise<File>;
  /** Directory sources only: regain read permission after a reload. */
  reauthorize?(): Promise<boolean>;
}

/**
 * `name|size|mtime` (plus the relative path when there is one) is the cheap
 * identity used to re-match a local file. The path is optional so keys written
 * before it existed still resolve, and so a server-side pending upload — which
 * knows nothing about folders — falls back to a name+size+mtime match.
 */
export function entryKey(name: string, size: number, mtime: number, path?: string): string {
  return path ? `${path}|${size}|${mtime}` : `${name}|${size}|${mtime}`;
}

export function isSupportedName(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_EXTENSIONS.includes(extension);
}

/** Whether an `<img>` can show this file without the HEIC decoder. */
export function isPreviewableName(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return PREVIEWABLE_EXTENSIONS.includes(extension);
}

/** Whether the walk found a video rather than a photo. */
export function isVideoName(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return VIDEO_EXTENSIONS.includes(extension);
}

function shouldDescend(name: string): boolean {
  if (name.startsWith('.')) return false;
  return !IGNORED_DIRECTORIES.includes(name.toLowerCase());
}

function relativePath(file: File): string | undefined {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return path ? path : undefined;
}

/** Directory handles are only available where the picker exists. */
export function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/**
 * Ask the user for a folder once, and remember the handle. Selecting a subset of
 * its files is a UI concern downstream: the permission is per folder, the
 * selection is per file.
 */
export async function pickDirectory(persistKey: string): Promise<DirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  const handle = await picker({ id: 'gallery-import', mode: 'read' });
  await putHandle(persistKey, handle);
  return handle;
}

export async function restoreDirectory(persistKey: string): Promise<DirectoryHandle | null> {
  return getHandle<DirectoryHandle>(persistKey);
}

/** Files the user picked through an `<input>`. Not resumable on its own. */
export class FileListSource implements UploadSource {
  readonly kind: SourceKind = 'files';
  readonly resumable = false;
  private readonly files: File[];

  constructor(files: File[]) {
    this.files = files;
  }

  async list(): Promise<SourceEntry[]> {
    return this.files
      .filter(file => isSupportedName(file.name))
      .map(file => ({ name: file.name, path: relativePath(file), size: file.size, mtime: file.lastModified, file }));
  }

  async open(entry: SourceEntry): Promise<File> {
    if (!entry.file) throw new Error('missing file');
    return entry.file;
  }
}

/**
 * A folder reached through showDirectoryPicker.
 *
 * The walk is recursive because photo libraries almost always nest their files
 * (`DCIM/100APPLE`, `2024/06`) — a shallow listing looks broken to anyone who
 * points at a camera card. It stops at MAX_ENTRIES/MAX_DEPTH so a pathological
 * folder cannot hang the tab, and it never reads file contents, only metadata.
 */
export class DirectorySource implements UploadSource {
  readonly kind: SourceKind = 'directory';
  readonly resumable = true;
  private readonly directory: DirectoryHandle;

  constructor(directory: DirectoryHandle) {
    this.directory = directory;
  }

  async list(): Promise<SourceEntry[]> {
    const entries: SourceEntry[] = [];
    await this.walk(this.directory, '', 0, entries);
    return entries;
  }

  private async walk(directory: DirectoryHandle, prefix: string, depth: number, out: SourceEntry[]): Promise<void> {
    for await (const entry of directory.values()) {
      if (out.length >= MAX_ENTRIES) return;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (depth >= MAX_DEPTH || !shouldDescend(entry.name)) continue;
        try {
          await this.walk(entry, path, depth + 1, out);
        } catch {
          // An unreadable subfolder must not abort the whole selection.
        }
        continue;
      }
      if (entry.name.startsWith('.') || !isSupportedName(entry.name)) continue;
      // A cheap fingerprint without reading a byte. getFile() is deferred until
      // the user actually queues the file.
      let size = 0;
      let mtime = 0;
      try {
        const file = await entry.getFile();
        size = file.size;
        mtime = file.lastModified;
      } catch {
        continue;
      }
      out.push({ name: entry.name, path, size, mtime, handle: entry });
    }
  }

  async open(entry: SourceEntry): Promise<File> {
    if (!entry.handle) throw new Error('missing handle');
    return entry.handle.getFile();
  }

  /**
   * Permission is granted per folder but not forever: a plain tab loses it when
   * closed, an installed PWA keeps it. Either way the browser needs a user
   * gesture to re-grant, so this must be called from a click handler.
   */
  async reauthorize(): Promise<boolean> {
    const descriptor = { mode: 'read' as const };
    try {
      if (await this.directory.queryPermission?.(descriptor) === 'granted') return true;
      if (await this.directory.requestPermission?.(descriptor) === 'granted') return true;
    } catch {
      return false;
    }
    return false;
  }
}

/** A `webkitdirectory` selection: no handle, so a resume needs re-picking. */
export class PickedDirectorySource extends FileListSource {
  override readonly kind: SourceKind = 'picker-directory';
}

/**
 * Open the system file picker from code.
 *
 * Needed by the resume path, which has no form to hang an `<input>` on: the user
 * clicked "choose the folder again" and the browser only grants file access
 * inside that gesture.
 */
export function pickFilesDialog(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = [...SUPPORTED_EXTENSIONS.map(extension => `.${extension}`), 'image/*', 'video/mp4'].join(',');
    // `cancel` is not universally supported, so the promise may simply never
    // settle when the user dismisses the picker. Nothing is leaked by that.
    input.addEventListener('change', () => resolve(Array.from(input.files || [])));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
