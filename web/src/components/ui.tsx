import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { X, Info, CheckCircle2, Aperture } from 'lucide-react';
import { useSite } from '../lib/site';
import { currentLocale, translate } from '../lib/i18n';

export function Brand({ compact = false }: { compact?: boolean }) {
  const site = useSite();
  return <span className="brand inline-flex items-center gap-2.5"><span className="brand-mark" aria-hidden="true"><Aperture className="brand-icon" /></span>{!compact && <span className="brand-word">{site.name}<span className="brand-tagline">{site.tagline}</span></span>}</span>;
}

export function Dialog({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startTime: number } | null>(null);
  const closeRef = useRef(onClose);
  const closeLabels = useRef([translate(currentLocale(), 'common.cancel'), translate(currentLocale(), 'common.close')]);
  closeLabels.current = [translate(currentLocale(), 'common.cancel'), translate(currentLocale(), 'common.close')];
  closeRef.current = onClose;
  const requestClose = () => {
    const dialog = ref.current;
    if (!dialog || window.matchMedia('(min-width: 701px)').matches || dialog.classList.contains('is-closing')) { closeRef.current(); return; }
    if (panelRef.current) panelRef.current.style.transform = '';
    dialog.classList.add('is-closing');
    window.setTimeout(() => closeRef.current(), 220);
  };
  const dragDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startTime: performance.now() };
  };
  const dragMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current || !panelRef.current) return;
    panelRef.current.style.transition = 'none';
    panelRef.current.style.transform = `translateY(${Math.max(0, event.clientY - drag.current.startY)}px)`;
  };
  const dragEnd = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current || !panelRef.current) return;
    const distance = event.clientY - drag.current.startY;
    const velocity = distance / Math.max(1, performance.now() - drag.current.startTime);
    drag.current = null;
    panelRef.current.style.transition = '';
    if (event.type !== 'pointercancel' && (distance > 110 || (distance > 30 && velocity > 1.1))) requestClose();
    else panelRef.current.style.transform = '';
  };
  const animatedClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled || !closeLabels.current.includes(button.textContent?.trim() || '')) return;
    if (window.matchMedia('(min-width: 701px)').matches) return;
    event.preventDefault(); event.stopPropagation(); requestClose();
  };
  const closeRefLatest = useRef(requestClose);
  closeRefLatest.current = requestClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.open) dialog.showModal();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const topmost = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop();
      if (topmost !== dialog) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeRefLatest.current();
    };
    dialog.addEventListener('keydown', escape, true);
    return () => { dialog.removeEventListener('keydown', escape, true); document.body.style.overflow = previousOverflow; if (dialog.open) dialog.close(); previouslyFocused?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'sm:w-[580px]' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); closeRefLatest.current(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRefLatest.current(); } }}>
    <div ref={panelRef} className="dialog-panel" onClickCapture={animatedClick}>
      <div className="dialog-grip lg:hidden" role="button" tabIndex={0} aria-label={translate(currentLocale(), 'common.dragToClose')}
        onPointerDown={dragDown} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}
        onClick={requestClose} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); requestClose(); } }}>
        <span className="dialog-handle" aria-hidden="true" />
      </div>
      <div className="flex items-start justify-between gap-5 mb-6">
        <div><h2 className="dialog-title">{title}</h2>{description && <p className="dialog-description">{description}</p>}</div>
        <button className="icon-btn dialog-close" onClick={requestClose} aria-label={translate(currentLocale(), 'common.close')}><X className="icon" /></button>
      </div>
      {children}
    </div>
  </dialog>;
}

export function Note({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return <div className="note"><Info className="icon" /><span className={warning ? 'text-[#a2663d]' : ''}>{children}</span></div>;
}

export function Toast({ message, onClose, action }: { message: string; onClose: () => void; action?: { label: string; run: () => void } }) {
  // A toast that offers undo lives longer: 4.5s is not enough time to read the
  // message and decide to reverse it.
  useEffect(() => { const timer = setTimeout(onClose, action ? 8000 : 4500); return () => clearTimeout(timer); }, [message, onClose, action]);
  return <div className="toast glass" role="status"><CheckCircle2 className="icon" /><span>{message}</span>{action && <button className="toast-action" onClick={() => { action.run(); onClose(); }}>{action.label}</button>}</div>;
}

export function Empty({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty">{icon}<h3>{title}</h3><p>{description}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label={translate(currentLocale(), 'common.loading')}>{Array.from({ length: rows * 3 }, (_, i) => <div key={i} className="skeleton aspect-[1.4] rounded-xl" />)}</div>;
}
