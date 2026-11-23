import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCaptureTime } from './exif';

// A real 64x48 JPEG written by Pillow with DateTimeOriginal set to
// 2026:08:03 10:11:12. Pillow writes a big-endian TIFF block, which also covers
// the MM branch of the header check.
const fixture = new Uint8Array(readFileSync(fileURLToPath(new URL('./__fixtures__/exif-sample.jpg', import.meta.url))));

type Options = { little?: boolean; date?: string | null; onlyDateTime?: boolean };

/**
 * Build a minimal but structurally valid TIFF block: header, IFD0, and either an
 * Exif sub-IFD holding DateTimeOriginal or DateTime directly in IFD0.
 */
function buildTiff({ little = true, date = '2026:08:03 10:11:12', onlyDateTime = false }: Options): Uint8Array {
  const bytes: number[] = [];
  const w16 = (value: number) => {
    bytes.push(little ? value & 0xff : (value >> 8) & 0xff, little ? (value >> 8) & 0xff : value & 0xff);
  };
  const w32 = (value: number) => {
    const parts = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
    if (!little) parts.reverse();
    bytes.push(...parts);
  };
  const ascii = new TextEncoder().encode((date ?? '') + '\0');

  const headerSize = 8;
  const ifdSize = 2 + 12 + 4;
  const withExifIfd = !onlyDateTime && !!date;
  // Layout: header, IFD0, then (optional) ExifIFD, then the date string.
  const exifIfdOffset = headerSize + ifdSize;
  const stringOffset = withExifIfd ? exifIfdOffset + ifdSize : headerSize + ifdSize;

  bytes.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]));
  w16(42);
  w32(headerSize);

  // IFD0: one entry, either a pointer to the Exif sub-IFD or DateTime itself.
  w16(1);
  if (withExifIfd) {
    w16(0x8769); w16(4); w32(1); w32(exifIfdOffset);
  } else {
    w16(0x0132); w16(2); w32(ascii.length); w32(stringOffset);
  }
  w32(0);

  if (withExifIfd) {
    w16(1);
    w16(0x9003); w16(2); w32(ascii.length); w32(stringOffset);
    w32(0);
  }

  bytes.push(...ascii);
  return new Uint8Array(bytes);
}

/**
 * Wrap a TIFF block the way an ISOBMFF Exif item is stored: a 4-byte size, the
 * "Exif" marker with two padding bytes, then the TIFF header.
 */
function wrapAsHeicExif(tiff: Uint8Array): Uint8Array {
  const wrapper = new Uint8Array(4 + 6 + tiff.length);
  wrapper.set([0, 0, 0, 6 + tiff.length], 0);
  wrapper.set(new TextEncoder().encode('Exif'), 4);
  wrapper.set(tiff, 10);
  return wrapper;
}

describe('readCaptureTime', () => {
  it('reads DateTimeOriginal from a real JPEG', () => {
    const date = readCaptureTime(fixture);
    expect(date).not.toBeNull();
    // Parsed as local wall-clock time, exactly as stored.
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(7); // August
    expect(date!.getDate()).toBe(3);
    expect(date!.getHours()).toBe(10);
    expect(date!.getMinutes()).toBe(11);
  });

  it('reads a little-endian Exif block found by scanning (the HEIC layout)', () => {
    const date = readCaptureTime(wrapAsHeicExif(buildTiff({ little: true })));
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(7);
    expect(date!.getDate()).toBe(3);
  });

  it('reads a big-endian Exif block', () => {
    const date = readCaptureTime(wrapAsHeicExif(buildTiff({ little: false })));
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getHours()).toBe(10);
  });

  it('falls back to DateTime in IFD0 when there is no Exif sub-IFD', () => {
    const date = readCaptureTime(wrapAsHeicExif(buildTiff({ onlyDateTime: true })));
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getDate()).toBe(3);
  });

  it('returns null for a file with no metadata', () => {
    expect(readCaptureTime(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readCaptureTime(new Uint8Array(64))).toBeNull();
  });

  it('rejects an impossible date instead of rolling it over', () => {
    // 2026-02-31 would become March 3rd if handed straight to Date.
    expect(readCaptureTime(wrapAsHeicExif(buildTiff({ date: '2026:02:31 10:00:00' })))).toBeNull();
  });

  it('rejects a placeholder date some cameras write', () => {
    expect(readCaptureTime(wrapAsHeicExif(buildTiff({ date: '0000:00:00 00:00:00' })))).toBeNull();
  });

  it('survives a truncated block without throwing', () => {
    const tiff = buildTiff({});
    expect(() => readCaptureTime(tiff.slice(0, 12))).not.toThrow();
  });
});
