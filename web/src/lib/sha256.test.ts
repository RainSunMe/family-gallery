import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from './sha256';

// Anything that gets a hash wrong here silently loses photos, so the
// implementation is pinned against the platform digest and the published
// FIPS 180-4 vectors.
async function platform(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function deterministic(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

describe('sha256', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches the platform digest across block boundaries', async () => {
    // 55/56/63/64/65 straddle the padding rule; 1 MiB covers the bulk path.
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 1 << 20]) {
      const bytes = deterministic(length, length + 7);
      expect(sha256Hex(bytes)).toBe(await platform(bytes));
    }
  });

  it('produces the same digest when fed in arbitrary chunks', async () => {
    const bytes = deterministic(300_000, 42);
    const expected = await platform(bytes);
    for (const chunk of [1, 7, 63, 64, 65, 1000, 131_072]) {
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        hash.update(bytes.subarray(offset, offset + chunk));
      }
      expect(hash.digest()).toBe(expected);
    }
  });
});
