import { Sha256 } from './sha256';

// The worker global scope is not part of the DOM lib this project compiles
// against, so only the two members actually used are declared here.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response) => void;
};

const CHUNK = 4 * 1024 * 1024;

type Request = { id: number; file: File };
type Response =
  | { id: number; type: 'progress'; read: number }
  | { id: number; type: 'done'; hash: string }
  | { id: number; type: 'error'; message: string };

scope.onmessage = async (event: MessageEvent<Request>) => {
  const { id, file } = event.data;
  try {
    const hash = new Sha256();
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const buffer = await file.slice(offset, offset + CHUNK).arrayBuffer();
      hash.update(new Uint8Array(buffer));
      scope.postMessage({ id, type: 'progress', read: Math.min(file.size, offset + CHUNK) });
    }
    scope.postMessage({ id, type: 'done', hash: hash.digest() });
  } catch (reason) {
    scope.postMessage({ id, type: 'error', message: reason instanceof Error ? reason.message : 'hash failed' });
  }
};
