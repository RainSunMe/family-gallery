import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Info, CheckCircle2, Aperture, LoaderCircle, ChevronDown, Check } from 'lucide-react';
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
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); closeRefLatest.current(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRefLatest.current(); } }}>
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

/**
 * A second step before anything destructive. Uses the shared Dialog so focus
 * trapping, Escape and the mobile drag-to-close behaviour all behave the same
 * as every other panel in the app.
 */
export function ConfirmDialog({ title, description, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onClose }: {
  title: string; description?: string; confirmLabel: string; cancelLabel: string;
  danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return <Dialog title={title} description={description} onClose={() => { if (!busy) onClose(); }}>
    <div className="dialog-actions">
      <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{cancelLabel}</button>
      <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm} disabled={busy}>
        {busy && <LoaderCircle className="icon animate-spin" />}{confirmLabel}
      </button>
    </div>
  </Dialog>;
}

export type SelectOption = { value: string; label: string };

/**
 * A dropdown that belongs to the app instead of the operating system.
 *
 * A native `<select>` opens the platform's own widget: a different font, radius
 * and shadow from everything else here, and on phones a full-screen wheel. This
 * keeps both the trigger and the list inside the design language — the trigger is
 * the same box as `.field`, the list uses the same frosted surface as the create
 * menu.
 *
 * The list is portalled into the surrounding `<dialog>` when there is one. A
 * modal dialog lives in the browser's top layer, so anything appended to <body>
 * would be painted underneath it.
 */
export function Select({ id, value, options, onChange, disabled = false, label, describedBy }: {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Accessible name when the visible label belongs to a separate element. */
  label?: string;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [popup, setPopup] = useState<{ host: HTMLElement; left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex];

  // Positioned from the trigger's rect because the list is fixed to the viewport.
  // It flips upwards when there is more room above than below, which is what makes
  // it usable inside a tall dialog near the bottom of the screen.
  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    setPopup({
      host: trigger.closest('dialog[open]') ?? document.body,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(140, Math.min(300, openUp ? spaceAbove : spaceBelow)),
      ...(openUp ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
    });
  }, []);

  const openList = useCallback(() => {
    setActive(selectedIndex);
    measure();
    setOpen(true);
  }, [measure, selectedIndex]);

  const close = useCallback(() => { setOpen(false); setPopup(null); }, []);

  const choose = useCallback((index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close();
    triggerRef.current?.focus({ preventScroll: true });
  }, [close, onChange, options]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [close, open]);

  // Escape is intercepted on `document` in the capture phase: the surrounding
  // Dialog listens on the dialog element, which is a descendant of document, so
  // this runs first and the panel stays open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close, open]);

  // A fixed list does not follow the page or the window on its own.
  useEffect(() => {
    if (!open) return;
    const update = () => measure();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [measure, open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) setActive(index => Math.min(options.length - 1, index + 1));
        else openList();
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (open) setActive(index => Math.max(0, index - 1));
        else openList();
        return;
      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActive(Math.max(0, options.length - 1));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) choose(active);
        else openList();
        return;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        close();
        return;
      case 'Tab':
        close();
        return;
      default:
        return;
    }
  };

  const list = open && popup ? createPortal(<div
    ref={listRef}
    id={listId}
    className="select-popup"
    role="listbox"
    aria-label={label}
    style={{ left: popup.left, width: popup.width, top: popup.top, bottom: popup.bottom, maxHeight: popup.maxHeight }}
  >
    {options.map((option, index) => <button
      key={option.value}
      type="button"
      role="option"
      id={optionId(index)}
      data-index={index}
      data-active={index === active}
      aria-selected={option.value === value}
      className="select-option"
      onPointerEnter={() => setActive(index)}
      onClick={() => choose(index)}
    >
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.value === value && <Check className="icon w-4 h-4 text-accent shrink-0" />}
    </button>)}
  </div>, popup.host) : null;

  return <>
    <button
      ref={triggerRef}
      type="button"
      id={id}
      className="select-trigger"
      disabled={disabled}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? optionId(active) : undefined}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => { if (open) close(); else openList(); }}
      onKeyDown={onKeyDown}
    >
      <span>{selected?.label ?? ''}</span>
      <ChevronDown className="select-chevron" aria-hidden="true" />
    </button>
    {list}
  </>;
}
