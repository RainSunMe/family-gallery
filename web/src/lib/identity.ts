import { useSyncExternalStore } from 'react';

// The uploader name is deliberately a client-only convenience: there are no
// user accounts, but a stable name lets the family tell uploads apart.
const STORAGE_KEY = 'gallery.displayName';
const EVENT = 'gallery:display-name';
export const DISPLAY_NAME_MAX = 100;

let cached: string | null = null;

function read(): string {
  try { return (localStorage.getItem(STORAGE_KEY) || '').trim().slice(0, DISPLAY_NAME_MAX); } catch { return ''; }
}

export function getDisplayName(): string {
  if (cached === null) cached = read();
  return cached;
}

export function setDisplayName(value: string): string {
  const name = value.trim().slice(0, DISPLAY_NAME_MAX);
  cached = name;
  try { if (name) localStorage.setItem(STORAGE_KEY, name); else localStorage.removeItem(STORAGE_KEY); } catch { /* storage optional */ }
  window.dispatchEvent(new Event(EVENT));
  return name;
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { cached = null; listener(); } };
  window.addEventListener('storage', onStorage);
  window.addEventListener(EVENT, listener);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(EVENT, listener); };
}

export function useDisplayName(): string {
  return useSyncExternalStore(subscribe, getDisplayName, () => '');
}
