import { describe, expect, it } from 'vitest';
import { entryKey, isSupportedName } from './source';
import { matchEntry, matchPending, pendingToRecord } from './matcher';
import type { PendingUpload } from '../api';

const entry = (name: string, size: number, mtime: number) => ({ name, size, mtime });

describe('entryKey', () => {
  it('identifies a file by name, size and mtime', () => {
    expect(entryKey('a.jpg', 10, 20)).toBe('a.jpg|10|20');
  });

  it('changes when any part changes', () => {
    expect(entryKey('a.jpg', 10, 20)).not.toBe(entryKey('a.jpg', 11, 20));
    expect(entryKey('a.jpg', 10, 20)).not.toBe(entryKey('b.jpg', 10, 20));
  });
});

describe('isSupportedName', () => {
  it('accepts the formats the pipeline can decode', () => {
    for (const name of ['a.jpg', 'B.JPEG', 'c.png', 'd.webp', 'e.gif', 'f.heic', 'g.HEIF']) {
      expect(isSupportedName(name)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const name of ['a.mp4', 'b.txt', 'no-extension', 'c.heic.bak']) {
      expect(isSupportedName(name)).toBe(false);
    }
  });
});

describe('matchEntry', () => {
  const record = { name: 'IMG_1.HEIC', size: 1000, mtime: 1700000000000 };

  it('returns an exact match when all three agree', () => {
    const found = matchEntry(record, [entry('IMG_1.HEIC', 1000, 1700000000000)]);
    expect(found?.exact).toBe(true);
  });

  it('falls back to name and size when the timestamp moved', () => {
    // Re-exported through a photo library, so lastModified is the export time.
    const found = matchEntry(record, [entry('IMG_1.HEIC', 1000, 1800000000000)]);
    expect(found?.exact).toBe(false);
    expect(found?.entry.mtime).toBe(1800000000000);
  });

  it('prefers the exact match when several files share a name and size', () => {
    const found = matchEntry(record, [
      entry('IMG_1.HEIC', 1000, 1800000000000),
      entry('IMG_1.HEIC', 1000, 1700000000000),
    ]);
    expect(found?.exact).toBe(true);
  });

  it('ignores a different size, which cannot be the same photo', () => {
    expect(matchEntry(record, [entry('IMG_1.HEIC', 1001, 1700000000000)])).toBeNull();
  });

  it('ignores a different name', () => {
    expect(matchEntry(record, [entry('IMG_2.HEIC', 1000, 1700000000000)])).toBeNull();
  });

  it('returns null for an empty source', () => {
    expect(matchEntry(record, [])).toBeNull();
  });
});

describe('matchPending', () => {
  const record = { name: 'a.jpg', size: 42, mtime: 1700000000000 };
  const pending = (overrides: Partial<PendingUpload>): PendingUpload => ({
    id: 'id', album_id: 'album', key: 'photos/originals/id/original', name: 'a.jpg', size: 42,
    mime: 'image/jpeg', content_hash: '', client_mtime: 1700000000000, taken_at: '',
    multipart: true, created_at: '', ...overrides,
  });

  it('adopts the session with the same fingerprint', () => {
    expect(matchPending(record, [pending({})])?.id).toBe('id');
  });

  it('ignores sessions with a different mtime', () => {
    expect(matchPending(record, [pending({ client_mtime: 123 })])).toBeNull();
  });

  it('accepts an older session that never recorded a mtime', () => {
    // Records created before client_mtime existed carry 0; name+size still match.
    expect(matchPending(record, [pending({ client_mtime: 0 })])?.id).toBe('id');
  });

  it('does not match a different size', () => {
    expect(matchPending(record, [pending({ size: 43 })])).toBeNull();
  });
});

describe('pendingToRecord', () => {
  it('builds a waiting record that knows its server session', () => {
    const record = pendingToRecord({
      id: 'srv-1', album_id: 'album-1', key: 'photos/originals/srv-1/original', name: 'a.jpg',
      size: 42, mime: 'image/jpeg', content_hash: 'abc', client_mtime: 99, taken_at: '',
      multipart: true, created_at: '',
    }, 'session-1');
    expect(record.status).toBe('waiting');
    expect(record.uploadId).toBe('srv-1');
    expect(record.sourceKey).toBe('a.jpg|42|99');
    expect(record.hash).toBe('abc');
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it('does not adopt a single-PUT session as multipart', () => {
    const record = pendingToRecord({
      id: 'srv-2', album_id: 'album-1', key: 'photos/originals/srv-2/original', name: 'a.jpg',
      size: 10, mime: 'image/jpeg', content_hash: '', client_mtime: 0, taken_at: '',
      multipart: false, created_at: '',
    }, 'session-1');
    expect(record.uploadId).toBeUndefined();
  });
});
