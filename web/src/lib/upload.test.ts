import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadGrant } from './api';

// The network is the only thing replaced: these tests are about the header a
// presigned PUT goes out with, which is exactly the thing that broke on Safari.
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api: mocks.api }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { sendOriginal, sendDerivatives } = await import('./upload');

function grant(overrides: Partial<UploadGrant> = {}): UploadGrant {
  return {
    id: 'up1',
    key: 'photos/originals/abc/original',
    url: 'https://bucket.example/photos/originals/abc/original?signature=1',
    thumb_url: 'https://bucket.example/photos/thumbs/abc/original.webp?signature=1',
    preview_url: 'https://bucket.example/photos/previews/abc/original.webp?signature=1',
    multipart_upload_id: '',
    part_size: 0,
    ...overrides,
  };
}

/** The Content-Type of the n-th PUT this test made. */
function sentType(call = 0): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.['Content-Type'];
}

beforeEach(() => {
  fetchMock.mockReset();
  mocks.api.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ ETag: '"abc"' }),
  } as unknown as Response);
});

describe('presigned PUT content type', () => {
  /**
   * The regression this file exists for: Safari reports an empty type for files
   * picked out of the iOS Files app. The signature was made for the resolved
   * mime, so sending the blob's own (absent) type produced a 403 the user reads
   * as a storage or CORS failure.
   */
  it('sends the registered mime when the file carries no type', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'F6F4B182-5A03-4C25-9266-4E88A8C41AEE.png', { type: '' });
    await sendOriginal(file, grant(), { mime: 'image/png' });
    expect(sentType()).toBe('image/png');
  });

  it('sends the registered mime when the browser guessed a different one', async () => {
    // `Blob.slice()` copies the type, so every part has to be told as well.
    const file = new File([new Uint8Array(6)], 'clip.mp4', { type: 'application/octet-stream' });
    await sendOriginal(file, grant(), { mime: 'video/mp4' });
    expect(sentType()).toBe('video/mp4');
  });

  it('sends the registered mime on every multipart part', async () => {
    mocks.api.mockResolvedValue({ url: 'https://bucket.example/part?signature=1' });
    const file = new File([new Uint8Array(5)], 'big.png', { type: '' });
    await sendOriginal(file, grant({ multipart_upload_id: 'mp1', part_size: 2 }), { mime: 'image/png' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([sentType(0), sentType(1), sentType(2)]).toEqual(['image/png', 'image/png', 'image/png']);
  });

  it('sends the type the derivatives were signed with', async () => {
    // Canvas output is always webp here, but the server signs a literal
    // `image/webp` pair, so the header must not come from the blob.
    const thumb = new Blob([new Uint8Array([1])], { type: '' });
    const preview = new Blob([new Uint8Array([2])], { type: 'application/octet-stream' });
    await sendDerivatives(grant(), { width: 10, height: 10, thumb, preview });
    expect([sentType(0), sentType(1)]).toEqual(['image/webp', 'image/webp']);
  });
});
