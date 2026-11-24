import { translate, currentLocale } from './i18n';

// Hashing runs in workers so a 200 MiB file never blocks the UI or inflates the
// tab's memory. Two at a time keeps a phone responsive while still saturating
// storage reads.
const CONCURRENCY = 2;

export type HashProgress = (done: number, total: number) => void;

type WorkerReply =
  | { id: number; type: 'progress'; read: number }
  | { id: number; type: 'done'; hash: string }
  | { id: number; type: 'error'; message: string };

type Task = { file: File; resolve: (hash: string) => void; reject: (error: Error) => void };
type Slot = { worker: Worker; current: number | null };

const slots: Slot[] = [];
const inFlight = new Map<number, { task: Task; slot: Slot }>();
const queue: Task[] = [];
let nextID = 1;
let total = 0;
let done = 0;
let report: HashProgress | undefined;

const hashFailed = () => new Error(translate(currentLocale(), 'upload.hashFailed'));

function reset(error: Error) {
  for (const pending of queue.splice(0)) pending.reject(error);
  for (const entry of inFlight.values()) entry.task.reject(error);
  inFlight.clear();
  for (const slot of slots) slot.current = null;
  total = 0;
  done = 0;
  report = undefined;
}

function pump() {
  for (const slot of slots) {
    if (slot.current !== null) continue;
    const task = queue.shift();
    if (!task) return;
    const id = nextID++;
    slot.current = id;
    inFlight.set(id, { task, slot });
    slot.worker.postMessage({ id, file: task.file });
  }
}

function createSlot(): Slot {
  const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
  const slot: Slot = { worker, current: null };
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const message = event.data;
    const entry = inFlight.get(message.id);
    if (!entry) return;
    // Per-file byte counts are too noisy to surface; the batch counter is enough.
    if (message.type === 'progress') return;
    inFlight.delete(message.id);
    entry.slot.current = null;
    if (message.type === 'done') {
      done += 1;
      report?.(done, total);
      entry.task.resolve(message.hash);
      pump();
      return;
    }
    const error = hashFailed();
    entry.task.reject(error);
    reset(error);
  };
  worker.onerror = () => reset(hashFailed());
  return slot;
}

/**
 * Hash every file, resolving to a map keyed by the File object. A worker failure
 * rejects the whole batch, so the caller never uploads a file whose hash is
 * unknown.
 */
export function hashFiles(files: File[], progress?: HashProgress): Promise<Map<File, string>> {
  if (!files.length) return Promise.resolve(new Map());
  total = files.length;
  done = 0;
  report = progress;
  progress?.(0, total);
  while (slots.length < Math.min(CONCURRENCY, files.length)) slots.push(createSlot());

  const results = new Map<File, string>();
  const pending = files.map(file => new Promise<void>((resolve, reject) => {
    queue.push({ file, resolve: hash => { results.set(file, hash); resolve(); }, reject });
  }));
  pump();
  return Promise.all(pending).then(() => results);
}

// hashFiles() keeps its batch counters and worker pool in module scope, so two
// concurrent batches would overwrite each other's progress and possibly resolve
// the wrong promise. The upload queue asks for one file at a time, so a promise
// chain is enough to serialise them and costs nothing: hashing is CPU-bound.
let serial: Promise<unknown> = Promise.resolve();

/** Hash a single file, waiting for any other single-file hash to finish first. */
export function hashOne(file: File): Promise<string> {
  const next = serial.then(async () => {
    const result = await hashFiles([file]);
    const hash = result.get(file);
    if (!hash) throw hashFailed();
    return hash;
  });
  // Keep the chain alive after a failure so one bad file does not wedge it.
  serial = next.catch(() => undefined);
  return next;
}
