// A deliberately empty service worker.
//
// It exists only so the app is installable: on desktop Chromium an installed PWA
// keeps the File System Access permission for a picked folder across sessions,
// which is what makes resuming a large upload one click instead of re-picking.
//
// It caches nothing on purpose. Every fetch falls through to the network, so a
// release can never leave a user staring at a stale bundle — the usual reason a
// service worker needs a versioned precache manifest and a cleanup strategy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only, by design */ });
