import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Info, LoaderCircle, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { Photo } from '../lib/api';
import { signPhoto } from '../lib/api';
import { useI18n, useT } from '../lib/i18n';

const urlCache = new Map<string, { created: number; request: Promise<string> }>();
function signedURL(id: string, variant: 'original' | 'thumb' | 'preview', guestToken: string) {
  const key = `${guestToken}:${id}:${variant}`;
  const cached = urlCache.get(key);
  if (cached && Date.now() - cached.created < 4 * 60 * 1000) return cached.request;
  const request = signPhoto(id, variant, guestToken).then(result => result.url).catch(error => { urlCache.delete(key); throw error; });
  urlCache.set(key, { created: Date.now(), request });
  return request;
}
function useSignedURL(id: string, variant: 'original' | 'thumb' | 'preview', guestToken: string) {
  const [url, setURL] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setURL(''); setFailed(false);
    signedURL(id, variant, guestToken).then(value => { if (active) setURL(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id, variant, guestToken]);
  return { url, failed };
}

type Point = { x: number; y: number };
type Offset = { x: number; y: number };
type Gesture = {
  pointers: Map<number, Point>;
  mode: 'pending' | 'swipe' | 'pan' | 'pinch';
  start: Point;
  startTime: number;
  startMidpoint: Point;
  startDistance: number;
  startScale: number;
  startOffset: Offset;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function PhotoViewer({ photos, initialIndex, onClose, guestToken = '', contributors }: { photos: Photo[]; initialIndex: number; onClose: () => void; guestToken?: string; contributors?: Record<string, string> }) {
  const { t, locale } = useI18n();
  const [index, setIndex] = useState(initialIndex);
  const [showInfo, setShowInfo] = useState(false);
  const [closingInfo, setClosingInfo] = useState(false);
  const [sheetDrag, setSheetDrag] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetGesture = useRef<{ startY: number; startTime: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [drag, setDrag] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [transition, setTransition] = useState<'idle' | 'next' | 'previous'>('idle');
  const stageRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const transformRef = useRef({ scale: 1, offset: { x: 0, y: 0 } });
  const transitionRef = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const photo = photos[index];
  const contributor = contributors?.[photo.id] || photo.contributor || '';

  const closeInfo = useCallback(() => {
    setSheetDrag(0);
    setClosingInfo(true);
    timers.current.push(setTimeout(() => { setShowInfo(false); setClosingInfo(false); }, 220));
  }, []);

  const openInfo = () => { setSheetDrag(0); setShowInfo(value => !value); };
  const sheetPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    sheetGesture.current = { startY: event.clientY, startTime: performance.now() };
    setSheetDragging(true);
  };
  const sheetPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!sheetGesture.current) return;
    setSheetDrag(Math.max(0, event.clientY - sheetGesture.current.startY));
  };
  const sheetPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = sheetGesture.current;
    sheetGesture.current = null;
    setSheetDragging(false);
    if (!gesture) return;
    const distance = event.clientY - gesture.startY;
    const elapsed = Math.max(1, performance.now() - gesture.startTime);
    if (event.type === 'pointercancel') { setSheetDrag(0); return; }
    if (distance > 110 || (distance > 30 && distance / elapsed > 1.1)) closeInfo();
    else setSheetDrag(0);
  };

  const updateTransform = useCallback((nextScale: number, nextOffset: Offset) => {
    const stage = stageRef.current?.getBoundingClientRect();
    const natural = stageRef.current?.querySelector<HTMLImageElement>('.is-current .viewer-image');
    let bounded = nextOffset;
    if (stage && natural?.naturalWidth && natural.naturalHeight) {
      const ratio = natural.naturalWidth / natural.naturalHeight;
      const fitWidth = Math.min(stage.width, stage.height * ratio);
      const fitHeight = Math.min(stage.height, stage.width / ratio);
      const maxX = Math.max(0, (fitWidth * nextScale - stage.width) / 2);
      const maxY = Math.max(0, (fitHeight * nextScale - stage.height) / 2);
      bounded = { x: clamp(nextOffset.x, -maxX, maxX), y: clamp(nextOffset.y, -maxY, maxY) };
    }
    transformRef.current = { scale: nextScale, offset: bounded };
    setScale(nextScale); setOffset(bounded);
  }, []);

  const boundedOffset = useCallback((nextScale: number, nextOffset: Offset) => {
    const stage = stageRef.current?.getBoundingClientRect();
    const natural = stageRef.current?.querySelector<HTMLImageElement>('.is-current .viewer-image');
    if (!stage) return nextOffset;
    const ratio = natural?.naturalWidth && natural.naturalHeight ? natural.naturalWidth / natural.naturalHeight : photo.width && photo.height ? photo.width / photo.height : 1;
    const fitWidth = Math.min(stage.width, stage.height * ratio);
    const fitHeight = Math.min(stage.height, stage.width / ratio);
    const maxX = Math.max(0, (fitWidth * nextScale - stage.width) / 2);
    const maxY = Math.max(0, (fitHeight * nextScale - stage.height) / 2);
    return { x: clamp(nextOffset.x, -maxX, maxX), y: clamp(nextOffset.y, -maxY, maxY) };
  }, [photo.width, photo.height]);

  const resetTransform = useCallback(() => {
    updateTransform(1, { x: 0, y: 0 }); setDrag({ x: 0, y: 0 }); setDragging(false);
    gestureRef.current = null;
  }, [updateTransform]);

  const navigate = useCallback((nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= photos.length || nextIndex === index || transitionRef.current) return;
    transitionRef.current = true;
    const direction = nextIndex > index ? 'next' : 'previous';
    setTransition(direction);
    setDrag({ x: direction === 'next' ? -Math.min(window.innerWidth * .16, 100) : Math.min(window.innerWidth * .16, 100), y: 0 });
    timers.current.push(setTimeout(() => {
      setIndex(nextIndex); resetTransform(); setShowInfo(false); setClosingInfo(false); setDrag({ x: 0, y: 0 });
      timers.current.push(setTimeout(() => { setTransition('idle'); transitionRef.current = false; }, 300));
    }, 150));
  }, [index, photos.length, resetTransform]);

  useEffect(() => {
    const body = document.body.style;
    const root = document.documentElement.style;
    const previous = { bodyOverflow: body.overflow, rootOverflow: root.overflow, bodyPosition: body.position, bodyWidth: body.width };
    body.overflow = 'hidden'; root.overflow = 'hidden'; body.position = 'fixed'; body.width = '100%';
    return () => { body.overflow = previous.bodyOverflow; root.overflow = previous.rootOverflow; body.position = previous.bodyPosition; body.width = previous.bodyWidth; timers.current.forEach(clearTimeout); };
  }, []);
  useEffect(() => { resetTransform(); }, [resetTransform]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const current = transformRef.current;
      const nextScale = clamp(current.scale * (event.deltaY < 0 ? 1.15 : .87), 1, 6);
      const nextOffset = nextScale === 1 ? { x: 0, y: 0 } : {
        x: event.clientX - (rect.left + rect.width / 2) - nextScale / current.scale * (event.clientX - (rect.left + rect.width / 2) - current.offset.x),
        y: event.clientY - (rect.top + rect.height / 2) - nextScale / current.scale * (event.clientY - (rect.top + rect.height / 2) - current.offset.y),
      };
      updateTransform(nextScale, boundedOffset(nextScale, nextOffset));
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [boundedOffset, updateTransform]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (showInfo) { closeInfo(); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.photo-viewer [data-viewer-control="info"]`)?.focus()); } else onClose(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(index + 1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(index - 1); }
      if (event.key === '+' || event.key === '=') updateTransform(Math.min(6, transformRef.current.scale * 1.4), transformRef.current.offset);
      if (event.key === '-') {
        const next = Math.max(1, transformRef.current.scale / 1.4);
        updateTransform(next, next === 1 ? { x: 0, y: 0 } : transformRef.current.offset);
      }
      if (event.key === '0') resetTransform();
      if (event.key === 'Tab') {
        const controls = [...document.querySelectorAll<HTMLButtonElement>('.photo-viewer button:not([disabled])')].filter(control => control.offsetParent !== null);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [index, navigate, onClose, resetTransform, showInfo, closeInfo, updateTransform]);

  function midpoint(points: Point[]) { return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }; }
  function distance(points: Point[]) { return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y); }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (showInfo || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    if (!gestureRef.current) {
      gestureRef.current = { pointers: new Map(), mode: 'pending', start: point, startTime: performance.now(), startMidpoint: point, startDistance: 0, startScale: transformRef.current.scale, startOffset: transformRef.current.offset };
    }
    const gesture = gestureRef.current;
    gesture.pointers.set(event.pointerId, point);
    setDragging(true);
    if (gesture.pointers.size === 2) {
      const points = [...gesture.pointers.values()];
      gesture.mode = 'pinch'; gesture.startDistance = distance(points); gesture.startMidpoint = midpoint(points);
      gesture.startScale = transformRef.current.scale; gesture.startOffset = transformRef.current.offset;
      setDrag({ x: 0, y: 0 });
    }
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture?.pointers.has(event.pointerId)) return;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...gesture.pointers.values()];
    if (gesture.mode === 'pinch' && points.length >= 2 && gesture.startDistance > 0) {
      const center = midpoint(points);
      const nextScale = clamp(gesture.startScale * distance(points) / gesture.startDistance, 1, 6);
      const stage = stageRef.current!.getBoundingClientRect();
      const nextOffset = {
        x: center.x - (stage.left + stage.width / 2) - nextScale / gesture.startScale * (gesture.startMidpoint.x - (stage.left + stage.width / 2) - gesture.startOffset.x),
        y: center.y - (stage.top + stage.height / 2) - nextScale / gesture.startScale * (gesture.startMidpoint.y - (stage.top + stage.height / 2) - gesture.startOffset.y),
      };
      updateTransform(nextScale, boundedOffset(nextScale, nextOffset));
      return;
    }
    const dx = event.clientX - gesture.start.x;
    const dy = event.clientY - gesture.start.y;
    if (transformRef.current.scale > 1) {
      gesture.mode = 'pan';
      updateTransform(transformRef.current.scale, boundedOffset(transformRef.current.scale, { x: gesture.startOffset.x + dx, y: gesture.startOffset.y + dy }));
      return;
    }
    if (gesture.mode === 'pending' && Math.hypot(dx, dy) > 7) gesture.mode = Math.abs(dx) >= Math.abs(dy) ? 'swipe' : 'pan';
    if (gesture.mode === 'swipe') {
      const atStart = index === 0 && dx > 0;
      const atEnd = index === photos.length - 1 && dx < 0;
      setDrag({ x: dx * (atStart || atEnd ? .3 : 1), y: 0 });
    } else if (gesture.mode === 'pan') setDrag({ x: 0, y: Math.max(0, dy) });
  }

  function pointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture) { setDrag({ x: 0, y: 0 }); setDragging(false); return; }
    gesture.pointers.delete(event.pointerId);
    if (gesture.pointers.size > 0) {
      const remaining = [...gesture.pointers.values()][0];
      gesture.mode = 'pending'; gesture.start = remaining; gesture.startTime = performance.now();
      gesture.startScale = transformRef.current.scale; gesture.startOffset = transformRef.current.offset;
      updateTransform(transformRef.current.scale, boundedOffset(transformRef.current.scale, transformRef.current.offset));
      return;
    }
    const cancelled = event.type === 'pointercancel';
    const dx = event.clientX - gesture.start.x;
    const dy = event.clientY - gesture.start.y;
    const atStart = index === 0 && dx > 0;
    const atEnd = index === photos.length - 1 && dx < 0;
    const velocity = dx / Math.max(1, performance.now() - gesture.startTime);
    const shouldNavigate = !cancelled && !atStart && !atEnd && gesture.mode === 'swipe' && transformRef.current.scale <= 1.04 && (Math.abs(dx) > Math.min(90, window.innerWidth * .22) || Math.abs(velocity) > .55);
    if (transformRef.current.scale <= 1.04) updateTransform(1, { x: 0, y: 0 });
    else updateTransform(transformRef.current.scale, boundedOffset(transformRef.current.scale, transformRef.current.offset));
    if (shouldNavigate) navigate(index + (dx < 0 ? 1 : -1));
    else if (!cancelled && gesture.mode === 'pan' && dy > 110 && Math.abs(dy) > Math.abs(dx) && transformRef.current.scale <= 1.04) onClose();
    else setDrag({ x: 0, y: 0 });
    gestureRef.current = null; setDragging(false);
  }

  function doubleClick(event: React.MouseEvent<HTMLDivElement>) {
    const stage = stageRef.current?.getBoundingClientRect();
    const current = transformRef.current;
    if (current.scale > 1) { updateTransform(1, { x: 0, y: 0 }); return; }
    if (!stage) return;
    const nextScale = 2.5;
    const nextOffset = {
      x: -(event.clientX - (stage.left + stage.width / 2) - current.offset.x) * (nextScale - 1),
      y: -(event.clientY - (stage.top + stage.height / 2) - current.offset.y) * (nextScale - 1),
    };
    updateTransform(nextScale, boundedOffset(nextScale, nextOffset));
  }

  return createPortal(<div className="photo-viewer" role="dialog" aria-modal="true" aria-label={t('viewer.dialog')}>
    <div className="viewer-backdrop" key={photo.id}><ViewerBackdrop photo={photo} guestToken={guestToken} /></div>
    <header className="viewer-header">
      <button className="icon-btn viewer-control" onClick={onClose} aria-label={t('viewer.close')} autoFocus><X className="icon" /></button>
      <div className="min-w-0 flex-1"><span className="block truncate text-xs text-white/85">{photo.name}</span><span className="block text-[10px] text-white/55 mt-0.5">{index + 1} / {photos.length}</span></div>
      {scale > 1 && <button className="viewer-zoom" onClick={resetTransform} aria-label={t('viewer.resetZoom')}>{scale.toFixed(1)}×</button>}
      <button className="icon-btn viewer-control" aria-label={t('viewer.download')} onClick={async () => { const result = await signPhoto(photo.id, 'original', guestToken, true); window.location.assign(result.url); }}><Download className="icon" /></button>
      <button className="icon-btn viewer-control" data-viewer-control="info" aria-label={t('viewer.info')} aria-expanded={showInfo} onClick={openInfo}><Info className="icon" /></button>
    </header>
    <div ref={stageRef} className={`viewer-stage ${dragging ? 'is-dragging' : ''} transition-${transition}`}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onDoubleClick={doubleClick}>
      <div className="viewer-track" style={{ transform: `translate3d(${drag.x}px,${drag.y}px,0)`, opacity: drag.y ? Math.max(.35, 1 - drag.y / 600) : 1 }}>
        {[-1, 0, 1].map(position => {
          const itemIndex = index + position;
          if (itemIndex < 0 || itemIndex >= photos.length) return null;
          return <div className={`viewer-slide ${position === 0 ? 'is-current' : ''}`} style={{ transform: `translateX(${position * (stageRef.current?.clientWidth || window.innerWidth)}px)` }} key={photos[itemIndex].id}>
            <ViewerImage photo={photos[itemIndex]} guestToken={guestToken} active={position === 0} scale={position === 0 ? scale : 1} offset={position === 0 ? offset : { x: 0, y: 0 }} />
          </div>;
        })}
      </div>
      {index > 0 && <button className="viewer-arrow previous" onPointerDown={event => event.stopPropagation()} onClick={() => navigate(index - 1)} aria-label={t('viewer.previous')}><ChevronLeft /></button>}
      {index < photos.length - 1 && <button className="viewer-arrow next" onPointerDown={event => event.stopPropagation()} onClick={() => navigate(index + 1)} aria-label={t('viewer.next')}><ChevronRight /></button>}
      <div className="viewer-hint" aria-hidden="true">{scale > 1 ? t('viewer.hintZoom') : t('viewer.hintSwipe')}</div>
    </div>
    {showInfo && <div className={`viewer-info-layer ${closingInfo ? 'is-closing' : ''}`} onClick={closeInfo}>
      <aside className={`viewer-info ${sheetDragging ? 'is-dragging' : ''}`} role="dialog" aria-modal="true" aria-label={t('viewer.infoDialog')} onClick={event => event.stopPropagation()} style={{ transform: sheetDrag ? `translateY(${sheetDrag}px)` : undefined }}>
        <div className="info-grip"
          onPointerDown={sheetPointerDown} onPointerMove={sheetPointerMove} onPointerUp={sheetPointerUp} onPointerCancel={sheetPointerUp}
          onClick={() => closeInfo()} role="button" tabIndex={0} aria-label={t('viewer.infoClose')}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeInfo(); } }}>
          <span className="info-handle" aria-hidden="true" />
        </div>
        <div className="flex items-start justify-between gap-4 mb-5"><div><h3>{t('viewer.infoTitle')}</h3><p>{t('viewer.infoSubtitle')}</p></div></div>
        <dl>
          <div><dt>{t('viewer.fileName')}</dt><dd>{photo.name}</dd></div>
          <div><dt>{t('viewer.dimensions')}</dt><dd>{t('viewer.pixels', { width: photo.width, height: photo.height })}</dd></div>
          <div><dt>{t('viewer.format')}</dt><dd>{photo.mime.replace('image/', '').toUpperCase()}</dd></div>
          <div><dt>{t('viewer.fileSize')}</dt><dd>{photo.size >= 1024 * 1024 ? `${(photo.size / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(photo.size / 1024))} KB`}</dd></div>
          <div><dt>{t('viewer.takenAt')}</dt><dd>{new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(photo.taken_at))}</dd></div>
          <div><dt>{t('viewer.position')}</dt><dd>{t('viewer.positionValue', { index: index + 1, total: photos.length })}</dd></div>
          {contributor && <div><dt>{t('viewer.origin')}</dt><dd>{contributor}</dd></div>}
        </dl>
        <p className="info-privacy">{t('viewer.privacy')}</p>
      </aside>
    </div>}
    <div className="viewer-filmstrip">{photos.map((item, itemIndex) => <button key={item.id} onClick={() => navigate(itemIndex)} className={itemIndex === index ? 'active' : ''} aria-label={t('viewer.thumb', { index: itemIndex + 1 })} aria-current={itemIndex === index ? 'true' : undefined}><ViewerThumb id={item.id} guestToken={guestToken} /></button>)}</div>
  </div>, document.body);
}

function ViewerBackdrop({ photo, guestToken }: { photo: Photo; guestToken: string }) {
  const { url } = useSignedURL(photo.id, 'preview', guestToken);
  return url ? <img src={url} alt="" /> : null;
}
function ViewerImage({ photo, guestToken, active, scale, offset }: { photo: Photo; guestToken: string; active: boolean; scale: number; offset: Offset }) {
  const t = useT();
  // A HEIC original only renders in browsers that can decode it, so the viewer
  // uses the WebP preview for those and keeps the original for the download
  // button. Preferring the original would show a broken image in Chrome.
  const heic = /hei[cf]/i.test(photo.mime);
  const original = useSignedURL(photo.id, heic ? 'preview' : 'original', guestToken);
  const preview = useSignedURL(photo.id, 'preview', guestToken);
  const url = original.url || preview.url;
  return <div className="viewer-image-wrap" style={{ transform: `translate3d(${offset.x}px,${offset.y}px,0) scale(${scale})` }}>
    {!original.url && !original.failed && active && <span className="viewer-loading"><LoaderCircle className="icon animate-spin" />{t('viewer.loading')}</span>}
    {url ? <img className="viewer-image" src={url} alt={photo.name} draggable={false} /> : original.failed && preview.failed ? <span className="text-xs text-white/65">{t('viewer.loadFailed')}</span> : null}
  </div>;
}
function ViewerThumb({ id, guestToken }: { id: string; guestToken: string }) {
  const { url } = useSignedURL(id, 'thumb', guestToken);
  return url ? <img className="w-full h-full object-cover" src={url} alt="" draggable={false} /> : <span className="block w-full h-full bg-white/10" />;
}
