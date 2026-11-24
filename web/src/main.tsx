import { createRoot } from 'react-dom/client';
import { Root } from './App';

createRoot(document.getElementById('root')!).render(<Root />);

// The service worker is what makes the app installable. Installation is the only
// way a desktop browser keeps the File System Access permission for a picked
// upload folder between sessions; without it every resume re-asks for the
// folder. It caches nothing, so registering it can never serve a stale build.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // An insecure origin or a blocked scope just means no install prompt.
    });
  });
}
