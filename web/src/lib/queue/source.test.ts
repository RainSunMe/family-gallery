import { describe, expect, it } from 'vitest';
import { DirectorySource, FileListSource, entryKey, isPreviewableName, isVideoName } from './source';

/**
 * A fake `FileSystemDirectoryHandle`. The real one can only be produced by a
 * user gesture, so a plain tree is the only way to test the walk.
 */
type Node = { file: { name: string; size: number; lastModified: number } } | { dir: string; children: Node[] };

function handle(children: Node[], name = 'root'): any {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const child of children) {
        if ('dir' in child) {
          yield { ...handle(child.children, child.dir), kind: 'directory', name: child.dir };
        } else {
          yield {
            kind: 'file',
            name: child.file.name,
            async getFile() {
              return child.file;
            },
          };
        }
      }
    },
  };
}

const photo = (name: string, size = 10, mtime = 100) => ({ file: { name, size, lastModified: mtime } });

describe('DirectorySource', () => {
  it('walks subfolders and keeps the relative path', async () => {
    const source = new DirectorySource(handle([
      photo('a.jpg'),
      { dir: '2024', children: [photo('b.jpg'), { dir: '06', children: [photo('c.heic')] }] },
    ]));
    const entries = await source.list();
    expect(entries.map(entry => entry.path)).toEqual(['a.jpg', '2024/b.jpg', '2024/06/c.heic']);
    expect(entries[0].name).toBe('a.jpg');
    expect(entries[2].name).toBe('c.heic');
  });

  it('skips unsupported files, dotfiles and junk folders', async () => {
    const source = new DirectorySource(handle([
      photo('note.txt'),
      photo('.DS_Store.jpg'),
      photo('keep.png'),
      { dir: '.git', children: [photo('x.jpg')] },
      { dir: '@eaDir', children: [photo('thumb.jpg')] },
    ]));
    const entries = await source.list();
    expect(entries.map(entry => entry.path)).toEqual(['keep.png']);
  });

  it('keeps MP4 videos alongside photos', async () => {
    const source = new DirectorySource(handle([
      photo('clip.mp4'),
      { dir: 'DCIM', children: [photo('IMG_0002.MP4'), photo('a.mov')] },
    ]));
    const entries = await source.list();
    expect(entries.map(entry => entry.path)).toEqual(['clip.mp4', 'DCIM/IMG_0002.MP4']);
    expect(isVideoName(entries[0].name)).toBe(true);
    expect(isVideoName(entries[1].name)).toBe(true);
  });

  it('keeps two same-named files from different folders apart', async () => {
    const source = new DirectorySource(handle([
      { dir: 'one', children: [photo('IMG_0001.JPG', 5, 7)] },
      { dir: 'two', children: [photo('IMG_0001.JPG', 5, 7)] },
    ]));
    const entries = await source.list();
    const keys = entries.map(entry => entryKey(entry.name, entry.size, entry.mtime, entry.path));
    expect(new Set(keys).size).toBe(2);
    expect(await source.open(entries[1])).toMatchObject({ name: 'IMG_0001.JPG' });
  });
});

describe('FileListSource', () => {
  it('filters non-photos before the queue sees them', async () => {
    const files = [
      new File(['abc'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['abc'], 'notes.txt', { type: 'text/plain' }),
    ];
    const entries = await new FileListSource(files).list();
    expect(entries.map(entry => entry.name)).toEqual(['a.jpg']);
    expect(entries[0].path).toBeUndefined();
  });
});

describe('isPreviewableName', () => {
  it('reports HEIC as not paintable but still supported', () => {
    expect(isPreviewableName('a.jpg')).toBe(true);
    expect(isPreviewableName('b.WEBP')).toBe(true);
    expect(isPreviewableName('c.heic')).toBe(false);
  });
});
