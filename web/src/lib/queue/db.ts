// IndexedDB persistence for the upload queue.
//
// Hand-written on purpose: the app needs one object store, one metadata store
// and a handful of operations. A dependency that only wraps these in promises
// would be more code to audit than to write.
//
// Every function degrades to an in-memory map when IndexedDB is unavailable
// (private windows, unit tests). The queue then simply does not survive a
// reload, which is the same as not having this module at all — never a crash.

import type { QueueRecord } from './types';

const DB_NAME = 'gallery-upload-queue';
const DB_VERSION = 1;
const RECORDS = 'records';
const META = 'meta';

let opening: Promise<IDBDatabase | null> | null = null;
let memoryMode = false;

const memoryRecords = new Map<string, QueueRecord>();
const memoryMeta = new Map<string, unknown>();

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function database(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>(resolve => {
    if (typeof indexedDB === 'undefined') {
      memoryMode = true;
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      memoryMode = true;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    // A blocked or failing open must not break uploading, only its durability.
    request.onerror = () => {
      memoryMode = true;
      resolve(null);
    };
    request.onblocked = () => {
      memoryMode = true;
      resolve(null);
    };
  });
  return opening;
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  const db = await database();
  if (!db) return null;
  try {
    return db.transaction(RECORDS, mode).objectStore(RECORDS);
  } catch {
    memoryMode = true;
    return null;
  }
}

export async function putRecord(record: QueueRecord): Promise<void> {
  if (memoryMode) {
    memoryRecords.set(record.id, record);
    return;
  }
  const target = await store('readwrite');
  if (!target) {
    memoryRecords.set(record.id, record);
    return;
  }
  try {
    await promisify(target.put(record));
  } catch {
    memoryRecords.set(record.id, record);
  }
}

/**
 * Write many records in one transaction.
 *
 * Enqueuing 1000 files one transaction at a time meant 1000 round trips through
 * the event loop, and the queue page re-rendered between each of them. A batch
 * is a single durable write as far as the caller is concerned.
 */
export async function putRecords(records: QueueRecord[]): Promise<void> {
  if (!records.length) return;
  if (memoryMode) {
    for (const record of records) memoryRecords.set(record.id, record);
    return;
  }
  const db = await database();
  if (!db) {
    for (const record of records) memoryRecords.set(record.id, record);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RECORDS, 'readwrite');
      const target = transaction.objectStore(RECORDS);
      for (const record of records) target.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    for (const record of records) memoryRecords.set(record.id, record);
  }
}

export async function deleteRecord(id: string): Promise<void> {
  memoryRecords.delete(id);
  const target = await store('readwrite');
  if (!target) return;
  try {
    await promisify(target.delete(id));
  } catch {
    /* already gone or storage unavailable */
  }
}

export async function allRecords(): Promise<QueueRecord[]> {
  const target = await store('readonly');
  if (!target) return [...memoryRecords.values()];
  try {
    const stored = await promisify(target.getAll() as IDBRequest<QueueRecord[]>);
    const merged = new Map(memoryRecords);
    for (const record of stored) merged.set(record.id, record);
    return [...merged.values()];
  } catch {
    return [...memoryRecords.values()];
  }
}

/**
 * Handles are structured-cloneable, so a directory the user authorised once can
 * be remembered. Permission itself is not: the browser re-asks, which is why
 * reauthorise() exists on the source.
 */
export async function putHandle(name: string, handle: unknown): Promise<void> {
  memoryMeta.set(name, handle);
  const db = await database();
  if (!db) return;
  try {
    await promisify(db.transaction(META, 'readwrite').objectStore(META).put(handle, name));
  } catch {
    /* the handle just will not be restorable */
  }
}

export async function getHandle<T>(name: string): Promise<T | null> {
  if (memoryMeta.has(name)) return memoryMeta.get(name) as T;
  const db = await database();
  if (!db) return null;
  try {
    const value = await promisify(db.transaction(META, 'readonly').objectStore(META).get(name) as IDBRequest<T | undefined>);
    return value ?? null;
  } catch {
    return null;
  }
}

export async function deleteHandle(name: string): Promise<void> {
  memoryMeta.delete(name);
  const db = await database();
  if (!db) return;
  try {
    await promisify(db.transaction(META, 'readwrite').objectStore(META).delete(name));
  } catch {
    /* nothing to clean up */
  }
}
