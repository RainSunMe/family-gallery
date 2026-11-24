// EXIF capture time.
//
// This reads the DateTimeOriginal tag straight out of the file bytes. It runs in
// the browser because the original never passes through the server, and because
// the browser is the only party that knows the uploader's time zone: EXIF stores
// a wall-clock time with no offset, so converting to UTC has to happen where the
// local offset is known.
//
// Supports the two containers that matter here:
//   - JPEG: the Exif block lives in an APP1 segment.
//   - HEIC/HEIF: the Exif item is prefixed with its own "Exif\0\0" marker.
// Both end at the same TIFF header, so the tag walker is shared.

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
const TAG_DATE_TIME = 0x0132;

// Scanning stops here. An Exif block that far into the file is not worth the
// walk, and this keeps a large video from stalling the tab.
const SCAN_LIMIT = 4 * 1024 * 1024;

/** Locate the TIFF header inside the raw bytes. */
function findTiffStart(bytes: Uint8Array): number {
  // JPEG: walk the segment chain rather than scanning, so a fake "Exif\0\0"
  // inside image data cannot be mistaken for the real block.
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break; // start of scan: no metadata after this
      const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (size < 2) break;
      if (marker === 0xe1 && size >= 8
        && bytes[offset + 4] === 0x45 && bytes[offset + 5] === 0x78
        && bytes[offset + 6] === 0x69 && bytes[offset + 7] === 0x66) {
        return offset + 10; // 4 header + 6 "Exif\0\0"
      }
      offset += 2 + size;
    }
  }
  // HEIC and everything else: find the marker, then verify a TIFF header
  // follows. The marker itself is four bytes of "Exif", two zero bytes.
  const limit = Math.min(bytes.length - 8, SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x78 || bytes[i + 2] !== 0x69 || bytes[i + 3] !== 0x66) continue;
    const start = i + 6;
    if (!isTiffHeader(bytes, start)) continue;
    return start;
  }
  return -1;
}

function isTiffHeader(bytes: Uint8Array, offset: number): boolean {
  if (offset + 8 > bytes.length) return false;
  // "II" means little endian, "MM" big endian, then the 42 magic number is
  // stored in that same byte order.
  if (bytes[offset] === 0x49 && bytes[offset + 1] === 0x49) {
    return bytes[offset + 2] === 0x2a && bytes[offset + 3] === 0x00;
  }
  if (bytes[offset] === 0x4d && bytes[offset + 1] === 0x4d) {
    return bytes[offset + 2] === 0x00 && bytes[offset + 3] === 0x2a;
  }
  return false;
}

type Reader = {
  little: boolean;
  u16: (offset: number) => number;
  u32: (offset: number) => number;
};

function makeReader(bytes: Uint8Array, tiff: number): Reader | null {
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    little,
    u16: offset => view.getUint16(offset, little),
    u32: offset => view.getUint32(offset, little),
  };
}

/** Read ASCII values of a resolved entry; EXIF dates are "YYYY:MM:DD HH:MM:SS". */
function readAscii(reader: Reader, bytes: Uint8Array, tiff: number, entry: number): string {
  const type = reader.u16(entry + 2);
  const count = reader.u32(entry + 4);
  if (type !== 2 || count === 0 || count > 64) return '';
  // Up to four bytes are stored inline, otherwise the value lives at an offset
  // that is relative to the TIFF header, not to the file.
  const valueOffset = count <= 4 ? entry + 8 : tiff + reader.u32(entry + 8);
  if (valueOffset + count > bytes.length) return '';
  let out = '';
  for (let i = 0; i < count; i++) {
    const code = bytes[valueOffset + i];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/** Walk one IFD and return its entries as tag -> absolute file offset. */
function readIfd(reader: Reader, tiff: number, ifdOffset: number, bytes: Uint8Array): Map<number, number> {
  const entries = new Map<number, number>();
  const base = tiff + ifdOffset;
  if (base + 2 > bytes.length) return entries;
  const count = reader.u16(base);
  if (count > 512) return entries;
  for (let i = 0; i < count; i++) {
    const entry = base + 2 + i * 12;
    if (entry + 12 > bytes.length) break;
    entries.set(reader.u16(entry), entry);
  }
  return entries;
}

/** Turn "2026:08:03 10:11:12" into a Date, or null when the value is unusable. */
function parseExifDate(value: string): Date | null {
  const match = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  // Interpreted in the uploader's time zone on purpose: that is when the photo
  // was taken from their point of view, and it is what the browser can reason
  // about. The caller converts to UTC.
  const date = new Date(year, month - 1, day, hour, minute, Math.min(second, 59));
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates such as 2026-02-31, which Date would roll over.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/**
 * Return the capture time as a Date in local time, or null when the file has no
 * usable timestamp. Never throws: a broken Exif block must not block an upload.
 */
export function readCaptureTime(bytes: Uint8Array): Date | null {
  try {
    const tiff = findTiffStart(bytes);
    if (tiff < 0) return null;
    const reader = makeReader(bytes, tiff);
    if (!reader) return null;

    // IFD0 first: DateTime (0x0132) is a coarse fallback many cameras write.
    const ifd0Offset = reader.u32(tiff + 4);
    const ifd0 = readIfd(reader, tiff, ifd0Offset, bytes);
    const exifPointer = ifd0.get(TAG_EXIF_IFD);
    if (exifPointer) {
      const exifIfd = readIfd(reader, tiff, reader.u32(exifPointer + 8), bytes);
      for (const tag of [TAG_DATE_TIME_ORIGINAL, TAG_DATE_TIME_DIGITIZED]) {
        const entry = exifIfd.get(tag);
        if (!entry) continue;
        const parsed = parseExifDate(readAscii(reader, bytes, tiff, entry));
        if (parsed) return parsed;
      }
    }
    const fallback = ifd0.get(TAG_DATE_TIME);
    if (fallback) return parseExifDate(readAscii(reader, bytes, tiff, fallback));
    return null;
  } catch {
    return null;
  }
}

/** Best-effort read from a File; returns an ISO UTC string or null. */
export async function captureTimeOf(file: File): Promise<string | null> {
  try {
    const head = new Uint8Array(await file.slice(0, SCAN_LIMIT).arrayBuffer());
    // EXIF first: an MP4 can carry an Exif item too, and it is the more precise
    // source when present. Otherwise fall back to the container's own header.
    let date = readCaptureTime(head) ?? readMp4CaptureTime(head);
    // Cameras write mdat before moov on many phones, which puts the header past
    // SCAN_LIMIT. A video's modification time is a good stand-in there, and it
    // is still far better for sorting than the upload time.
    if (!date && looksLikeVideo(file)) date = new Date(file.lastModified);
    if (!date || Number.isNaN(date.getTime())) return null;
    // Guard against clocks set wildly wrong; a capture date in the future would
    // sort above everything else in the album.
    const now = Date.now();
    if (date.getTime() > now + 24 * 60 * 60 * 1000) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

function looksLikeVideo(file: File): boolean {
  if (/^video\//i.test(file.type)) return true;
  return /\.mp4$/i.test(file.name);
}

// ---------------------------------------------------------------------------
// MP4 capture time
//
// A video's date lives in `moov/mvhd`, not in EXIF. The value counts seconds
// from 1904-01-01 UTC, which is why it can be converted straight to ISO without
// the local-time dance the JPEG path needs. Readers stop at the same size limit
// as the rest of this file, so a `moov` at the end of a huge file is simply not
// found and the upload falls back to its arrival time.
// ---------------------------------------------------------------------------

const MP4_EPOCH = Date.UTC(1904, 0, 1);

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Locate the first child box of `type` in [start, end). */
function findBox(bytes: Uint8Array, start: number, end: number, type: string): { payload: number; end: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const kind = boxType(bytes, offset + 4);
    if (size === 1) {
      // The 64-bit size form is only used by boxes over 4 GiB, but must be
      // skipped correctly to keep the chain in sync.
      if (offset + 16 > end) return null;
      const high = ((bytes[offset + 8] << 24) | (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11]) >>> 0;
      const low = ((bytes[offset + 12] << 24) | (bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15]) >>> 0;
      size = high * 0x100000000 + low;
    } else if (size === 0) {
      size = end - offset; // "extends to the end of the file"
    }
    if (size < 8 || offset + size > end) return null;
    if (kind === type) return { payload: offset + 8, end: offset + size };
    offset += size;
  }
  return null;
}

function readMp4CaptureTime(bytes: Uint8Array): Date | null {
  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (!moov) return null;
  const mvhd = findBox(bytes, moov.payload, moov.end, 'mvhd');
  if (!mvhd) return null;
  const version = bytes[mvhd.payload];
  // version + flags occupy four bytes before the time fields.
  const base = mvhd.payload + 4;
  let seconds: number;
  if (version === 1) {
    if (base + 8 > mvhd.end) return null;
    const high = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
    const low = ((bytes[base + 4] << 24) | (bytes[base + 5] << 16) | (bytes[base + 6] << 8) | bytes[base + 7]) >>> 0;
    seconds = high * 0x100000000 + low;
  } else {
    if (base + 4 > mvhd.end) return null;
    seconds = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
  }
  // Zero means "not set", and 1904 dates are not real recordings.
  if (seconds <= 0) return null;
  const date = new Date(MP4_EPOCH + seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}
