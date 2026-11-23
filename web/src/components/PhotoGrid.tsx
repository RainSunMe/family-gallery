import { useEffect, useRef, useState } from 'react';
import { Check, CheckSquare2, ImageIcon, ImageOff, Trash2 } from 'lucide-react';
import type { Photo } from '../lib/api';
import { formatDate } from '../lib/api';
import { useT } from '../lib/i18n';

export { PhotoViewer } from './PhotoViewer';

export function PhotoGrid({ photos, urls, selecting, selected, onSelect, onStartSelection, onOpen, origins, onSetCover, onTrash }: {
  photos: Photo[]; urls: Record<string, string>; selecting: boolean; selected: Set<string>;
  onSelect: (id: string) => void; onStartSelection: (id: string) => void; onOpen: (index: number) => void;
  origins?: Record<string, string>; onSetCover?: (photo: Photo) => void | Promise<void>;
  onTrash?: (photo: Photo) => void;
}) {
  const t = useT();
  const [context, setContext] = useState<{ x: number; y: number; index: number } | null>(null);
  const longPress = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean }>({ x: 0, y: 0, fired: false });
  const contextPhoto = context ? photos[context.index] : null;

  useEffect(() => {
    if (!context) return;
    const close = () => setContext(null);
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('keydown', keyboard); };
  }, [context]);
  useEffect(() => () => window.clearTimeout(longPress.current.timer), []);

  const openContext = (x: number, y: number, index: number) => {
    window.clearTimeout(longPress.current.timer);
    // Keep the menu on screen: each entry is ~44px, plus the panel padding.
    const entries = 2 + (onSetCover ? 1 : 0) + (onTrash ? 1 : 0);
    setContext({ x: Math.max(8, Math.min(x, window.innerWidth - 208)), y: Math.max(8, Math.min(y, window.innerHeight - (entries * 44 + 22))), index });
  };
  const groups = new Map<string, { photo: Photo; index: number }[]>();
  photos.forEach((photo, index) => { const date = formatDate(photo.taken_at); if (!groups.has(date)) groups.set(date, []); groups.get(date)!.push({ photo, index }); });
  return <div className={selecting ? 'selecting' : ''}>{[...groups.entries()].map(([date, items]) => <section key={date}>
    <h2 className="flex items-center gap-2.5 my-5 text-sm font-medium">{date}<small className="text-[11px] text-muted font-normal">{t('grid.moments', { count: items.length })}</small></h2>
    <div className="photo-grid">{items.map(({ photo, index }) => <button key={photo.id} className={`photo-tile ${selected.has(photo.id) ? 'selected' : ''}`}
      onClick={() => { if (longPress.current.fired) { longPress.current.fired = false; return; } if (selecting) onSelect(photo.id); else onOpen(index); }}
      onContextMenu={event => { event.preventDefault(); openContext(event.clientX, event.clientY, index); }}
      onPointerDown={event => {
        if (event.pointerType === 'mouse') return;
        longPress.current.fired = false;
        longPress.current.x = event.clientX; longPress.current.y = event.clientY;
        longPress.current.timer = setTimeout(() => { longPress.current.fired = true; if (navigator.vibrate) navigator.vibrate(20); onStartSelection(photo.id); }, 480);
      }}
      onPointerMove={event => { if (Math.hypot(event.clientX - longPress.current.x, event.clientY - longPress.current.y) > 10) clearTimeout(longPress.current.timer); }}
      onPointerUp={() => clearTimeout(longPress.current.timer)}
      onPointerCancel={() => clearTimeout(longPress.current.timer)}
      aria-label={t('grid.ariaPhoto', { action: selecting ? t('grid.actionSelect') : t('grid.actionView'), name: photo.name })}
      aria-pressed={selecting ? selected.has(photo.id) : undefined}>
      {urls[photo.id] ? <img src={urls[photo.id]} alt={photo.name} loading="lazy" draggable={false} /> : <span className="photo-fallback"><ImageOff className="icon" /></span>}
      {photo.contributor && <span className="photo-contributor" title={t('grid.uploadedBy', { name: photo.contributor })}>{photo.contributor}</span>}
      <span className="photo-select-mask" aria-hidden="true" />
      <span className="photo-check"><Check /></span>
      {origins?.[photo.id] && <span className={`photo-origin ${origins[photo.id] === t('grid.imported') ? 'is-imported' : 'is-pending'}`} title={origins[photo.id]} aria-label={origins[photo.id]}>{origins[photo.id] === t('grid.imported') ? <Check className="icon" /> : <span className="dot" aria-hidden="true" />}</span>}
    </button>)}</div>
  </section>)}
  {context && contextPhoto && <div className="photo-context" role="menu" style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()}>
    <button role="menuitem" autoFocus onClick={() => { onStartSelection(contextPhoto.id); setContext(null); }}><CheckSquare2 className="icon" />{t('grid.multiSelect')}</button>
    <button role="menuitem" onClick={() => { onOpen(context.index); setContext(null); }}><ImageIcon className="icon" />{t('grid.viewPhoto')}</button>
    {onSetCover && <button role="menuitem" onClick={() => { void onSetCover(contextPhoto); setContext(null); }}><ImageIcon className="icon" />{t('grid.setCover')}</button>}
    {onTrash && <button role="menuitem" className="danger" onClick={() => { onTrash(contextPhoto); setContext(null); }}><Trash2 className="icon" />{t('grid.moveToTrash')}</button>}
  </div>}
  </div>;
}

