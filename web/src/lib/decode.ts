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
  return '';
}

export const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

/**
 * The `accept` attribute for file pickers. Extensions are listed alongside the
 * MIME types because macOS and Windows disagree about the MIME of .heic, and a
 * picker that silently hides a file is worse than one that shows too much.
 */
export const UPLOAD_ACCEPT = [...SUPPORTED_MIME, '.heic', '.heif', '.jpg', '.jpeg', '.png', '.webp', '.gif'].join(',');

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

/** Downscale a decoded image to a WebP blob whose longest side is `max`. */
export async function resizeToWebp(decoded: Decoded, max: number, quality = 0.84): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(decoded.width, decoded.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error(translate(currentLocale(), 'upload.previewUnsupported'));
  context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(translate(currentLocale(), 'upload.previewFailed'))), 'image/webp', quality);
  });
}
