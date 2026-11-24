// Decoding is the one place that knows how to turn a File into pixels.
//
// Browsers disagree about HEIC: Safari on macOS Sonoma and iOS 17+ decode it
// natively, Chrome and Firefox do not decode it at all. Rather than sniffing the
// user agent, this tries the platform decoder first and falls back to a
// WebAssembly build of libheif. The fallback is a ~2 MB lazy chunk, so a browser
// that can already decode HEIC never downloads it.
import { translate, currentLocale } from './i18n';

const HEIC = /image\/hei[cf]/i;
const HEIC_EXT = /\.hei[cf]$/i;

/** Browsers often report an empty type for .heic, so the extension counts too. */
export function looksLikeHeic(file: File): boolean {
  return HEIC.test(file.type) || HEIC_EXT.test(file.name);
}

/** The MIME to send to the server, filling in what the OS could not guess. */
export function resolveMime(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'heif') return 'image/heif';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'mp4') return 'video/mp4';
  return '';
}

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

/**
 * Only MP4 (H.264/AAC) is on the list. The server accepts the container, but a
 * browser can only play it when the codecs are the ones every platform ships;
 * anything else is rejected at upload time instead of being stored unplayable.
 */
export const VIDEO_MIME = ['video/mp4'];

export const SUPPORTED_MIME = [...IMAGE_MIME, ...VIDEO_MIME];

/** Media type checks. Kept here so no caller re-implements the prefix test. */
export function isVideoMime(mime: string): boolean {
  return /^video\//i.test(mime);
}

export function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime);
}

/**
 * The `accept` attribute for file pickers. Extensions are listed alongside the
 * MIME types because macOS and Windows disagree about the MIME of .heic, and a
 * picker that silently hides a file is worse than one that shows too much.
 */
export const UPLOAD_ACCEPT = [...SUPPORTED_MIME, '.heic', '.heif', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4'].join(',');

/** Everything the rest of the app needs from a decoded file. */
export type Decoded = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

type HeifImage = { get_width(): number; get_height(): number; display(data: ImageData, done: (result?: ImageData) => void): void };
type HeifModule = { HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] } };

// One shared import promise: a batch of HEIC files must not download the decoder
// more than once.
let heifLoader: Promise<HeifModule> | null = null;

async function loadHeif(): Promise<HeifModule> {
  if (!heifLoader) {
    heifLoader = import('libheif-js/libheif-wasm/libheif-bundle.mjs')
      .then(module => (module.default as unknown as () => HeifModule)())
      .catch(reason => { heifLoader = null; throw reason; });
  }
  return heifLoader;
}

async function decodeWithHeif(file: File): Promise<{ source: HTMLCanvasElement; width: number; height: number }> {
  const heif = await loadHeif();
  const decoder = new heif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  if (!images.length) throw new Error(translate(currentLocale(), 'upload.heicUnreadable'));
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(translate(currentLocale(), 'upload.previewUnsupported'));
  const target = context.createImageData(width, height);
  const drawn = await new Promise<boolean>(resolve => {
    image.display(target, result => resolve(!!result));
  });
  if (!drawn) throw new Error(translate(currentLocale(), 'upload.heicUnreadable'));
  context.putImageData(target, 0, 0);
  return { source: canvas, width, height };
}

/**
 * Decode a file once. Callers derive both the thumbnail and the preview from the
 * returned source, so a photo is only decoded a single time no matter how many
 * sizes are generated.
 */
export async function decodeImage(file: File): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch (nativeError) {
    if (!looksLikeHeic(file)) throw new Error(translate(currentLocale(), 'upload.readDimensions'));
    try {
      const decoded = await decodeWithHeif(file);
      return { ...decoded, release: () => { /* the canvas is garbage collected */ } };
    } catch {
      // Report the HEIC problem, not the import failure: the user needs to know
      // the file could not be read, not which module failed.
      throw new Error(translate(currentLocale(), 'upload.heicUnsupported'));
    }
  }
}

/** Anything with pixels and a size: an image bitmap, a HEIC canvas or a video frame. */
export type PixelSource = { source: CanvasImageSource; width: number; height: number };

/** Downscale a decoded image to a WebP blob whose longest side is `max`. */
export async function resizeToWebp(decoded: PixelSource, max: number, quality = 0.84): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(decoded.width, decoded.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error(translate(currentLocale(), 'upload.previewUnsupported'));
  context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/webp', quality);
}

/** `canvas.toBlob` with a rejected promise instead of a null result. */
export function canvasToBlob(canvas: HTMLCanvasElement, mime = 'image/webp', quality = 0.84): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(translate(currentLocale(), 'upload.previewFailed'))), mime, quality);
  });
}

/** A frame pulled out of a video: painted pixels plus the clip's own dimensions. */
export type VideoFrame = { source: HTMLCanvasElement; width: number; height: number };

function waitForMediaEvent(video: HTMLVideoElement, event: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener(event, ok);
      video.removeEventListener('error', fail);
      if (error) reject(error); else resolve();
    };
    const ok = () => finish();
    const fail = () => finish(new Error(translate(currentLocale(), 'upload.videoUnreadable')));
    // A network-backed file would never be slow, but a 3 GB clip on a phone can
    // take a while before the first frame is decodable.
    const timer = setTimeout(fail, timeout);
    video.addEventListener(event, ok);
    video.addEventListener('error', fail);
  });
}

/**
 * Paint a frame of a video onto a canvas.
 *
 * This is the video equivalent of `decodeImage`: the pipeline only ever needs
 * one still, and painting it here means the thumbnail and the preview are
 * produced by exactly the same code path as a photo. `maxEdge` bounds the
 * canvas, never the reported width/height, which stay the clip's real size so
 * the viewer can keep the aspect ratio right.
 */
export async function decodeVideoFrame(file: File, maxEdge = 0): Promise<VideoFrame> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    video.load();
    await waitForMediaEvent(video, 'loadeddata', 20000);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error(translate(currentLocale(), 'upload.videoUnreadable'));
    // The first keyframe is often black; a hair into the clip makes a better
    // cover without materially changing what the video is.
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0.2) {
      video.currentTime = Math.min(0.25, duration / 10);
      await waitForMediaEvent(video, 'seeked', 20000);
    }
    const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(translate(currentLocale(), 'upload.previewUnsupported'));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { source: canvas, width, height };
  } finally {
    // Dropping the source is what releases the decoder; revoking the URL alone
    // leaves the media element holding the file.
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
