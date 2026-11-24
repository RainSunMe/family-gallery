import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Extra actions that belong to the page rather than to the shell. The shell owns
 * the button and the menu; the page only says what goes in it, so an album can
 * contribute "edit" and "delete" without the topbar knowing what an album is.
 */
export type HeaderMoreActions = { onEdit?: () => void; onDelete?: () => void };

type HeaderContextValue = {
  title: string;
  setTitle: (title: string) => void;
  back: string;
  setBack: (path: string) => void;
  download: string;
  setDownload: (id: string) => void;
  share: string;
  setShare: (albumID: string) => void;
  more: HeaderMoreActions;
  setMore: (actions: HeaderMoreActions) => void;
};

const HeaderContext = createContext<HeaderContextValue | null>(null);

export function HeaderTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState('');
  const [back, setBack] = useState('');
  const [download, setDownload] = useState('');
  const [share, setShare] = useState('');
  const [more, setMore] = useState<HeaderMoreActions>({});
  return <HeaderContext.Provider value={{ title, setTitle, back, setBack, download, setDownload, share, setShare, more, setMore }}>{children}</HeaderContext.Provider>;
}

export function useHeaderTitleState() {
  const context = useContext(HeaderContext);
  if (!context) throw new Error('Header title state requires the header provider');
  return context;
}
export function useHeaderBack(path: string) {
  const { setBack } = useHeaderTitleState();
  useEffect(() => { setBack(path); return () => setBack(''); }, [path, setBack]);
}
export function useHeaderDownload(id: string) {
  const { setDownload } = useHeaderTitleState();
  useEffect(() => { setDownload(id); return () => setDownload(''); }, [id, setDownload]);
}
export function useHeaderShare(albumID: string) {
  const { setShare } = useHeaderTitleState();
  useEffect(() => { setShare(albumID); return () => setShare(''); }, [albumID, setShare]);
}

/**
 * Contribute the page's own entries to the top-right "more" menu.
 *
 * The callbacks are re-registered whenever their identity changes, which is why
 * callers pass their props straight through instead of a memoised wrapper: a
 * stable wrapper would keep pointing at the album the page was first mounted
 * for after the user navigates to a different one.
 */
export function useHeaderMore({ onEdit, onDelete }: HeaderMoreActions) {
  const { setMore } = useHeaderTitleState();
  useEffect(() => {
    setMore({ onEdit, onDelete });
    return () => setMore({});
  }, [onEdit, onDelete, setMore]);
}

export function usePageTitleScroll(title: string) {
  const { setTitle } = useHeaderTitleState();
  return useCallback((node: HTMLElement | null) => {
    if (!node) return undefined;
    const update = () => {
      const header = document.querySelector<HTMLElement>('.topbar');
      const bottom = header?.getBoundingClientRect().bottom || 56;
      setTitle(node.getBoundingClientRect().top < bottom ? title : '');
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); setTitle(''); };
  }, [title, setTitle]);
}
