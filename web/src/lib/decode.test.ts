import { describe, expect, it } from 'vitest';
import { looksLikeHeic, resolveMime, UPLOAD_ACCEPT, SUPPORTED_MIME } from './decode';

function file(name: string, type: string): File {
  return new File([new Uint8Array([0])], name, { type });
}

describe('looksLikeHeic', () => {
  it('trusts the MIME type', () => {
    expect(looksLikeHeic(file('a.bin', 'image/heic'))).toBe(true);
    expect(looksLikeHeic(file('a.bin', 'image/heif'))).toBe(true);
  });

  it('falls back to the extension because the type is often empty', () => {
    // macOS hands .heic files to a browser with an empty type surprisingly often.
    expect(looksLikeHeic(file('IMG_1234.heic', ''))).toBe(true);
    expect(looksLikeHeic(file('IMG_1234.HEIF', ''))).toBe(true);
  });

  it('does not match other formats', () => {
    expect(looksLikeHeic(file('a.jpg', 'image/jpeg'))).toBe(false);
    expect(looksLikeHeic(file('heic.jpg', 'image/jpeg'))).toBe(false);
    expect(looksLikeHeic(file('photo.png', ''))).toBe(false);
  });
});

describe('resolveMime', () => {
  it('keeps a type the browser already reported', () => {
    expect(resolveMime(file('a.bin', 'image/jpeg'))).toBe('image/jpeg');
    expect(resolveMime(file('a.bin', 'IMAGE/PNG'))).toBe('image/png');
  });

  it('derives the type from the extension when it is missing', () => {
    expect(resolveMime(file('x.heic', ''))).toBe('image/heic');
    expect(resolveMime(file('x.heif', ''))).toBe('image/heif');
    expect(resolveMime(file('x.jpeg', ''))).toBe('image/jpeg');
    expect(resolveMime(file('x.JPG', ''))).toBe('image/jpeg');
    expect(resolveMime(file('x.webp', ''))).toBe('image/webp');
    expect(resolveMime(file('x.gif', ''))).toBe('image/gif');
    expect(resolveMime(file('x.mp4', ''))).toBe('video/mp4');
    expect(resolveMime(file('x.MP4', ''))).toBe('video/mp4');
  });

  it('returns an empty string for an unknown file', () => {
    expect(resolveMime(file('notes.txt', ''))).toBe('');
    expect(resolveMime(file('archive.zip', ''))).toBe('');
  });
});

describe('upload accept list', () => {
  it('includes both MIME types and extensions', () => {
    // A picker that greys out a real photo is worse than one that shows extras,
    // and platforms disagree about the MIME type of .heic.
    for (const mime of SUPPORTED_MIME) expect(UPLOAD_ACCEPT).toContain(mime);
    for (const ext of ['.heic', '.heif', '.jpg', '.png', '.webp', '.gif', '.mp4']) expect(UPLOAD_ACCEPT).toContain(ext);
  });
});
