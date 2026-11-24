import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, CalendarRange, FolderPlus, Heart, Image, Images, Link2, LoaderCircle, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Album, DownloadJob, Photo } from '../lib/api';
import { createDownload, getAlbum, getDownload, listAlbums, listPhotos, setAlbumCover, signDownload, updateAlbum } from '../lib/api';
import { Dialog, Empty, Loading, Note } from './ui';
import { useLocale, useT } from '../lib/i18n';
import { usePageTitleScroll, useHeaderBack, useHeaderDownload, useHeaderShare } from './HeaderTitleContext';
import { PhotoGrid, PhotoViewer } from './PhotoGrid';

// Compacts two capture timestamps into one readable range. Photos are stored in
// UTC; dates are rendered in the visitor's own time zone, so "same day" is
// decided on local calendar parts rather than on the raw string.
export function formatTakenRange(fromISO: string, toISO: string, locale: string): string {
  if (!fromISO || !toISO) return '';
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '';
  const zh = locale === 'zh';
  const tag = zh ? 'zh-CN' : 'en-US';
  const full = (date: Date) => new Intl.DateTimeFormat(tag, { year: 'numeric', month: zh ? 'long' : 'short', day: 'numeric' }).format(date);
  const monthDay = (date: Date) => new Intl.DateTimeFormat(tag, { month: zh ? 'long' : 'short', day: 'numeric' }).format(date);
  const sameDay = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth() && from.getDate() === to.getDate();
  if (sameDay) return full(from);
  if (from.getFullYear() === to.getFullYear()) {
    // Keep the year on the side the language reads first.
    return zh ? `${full(from)} – ${monthDay(to)}` : `${monthDay(from)} – ${full(to)}`;
  }
  return `${full(from)} – ${full(to)}`;
}

export function PageHeading({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  const titleRef = usePageTitleScroll(title);
  return <div className="flex items-start sm:items-center justify-between gap-5 mb-7"><div className="min-w-0" ref={titleRef}><h1 className="page-title">{title}<span className="text-accent">.</span></h1><p className="page-description">{description}</p></div><div className="flex gap-2 shrink-0 pt-3">{children}</div></div>;
}

export function AlbumsPage({ onNewAlbum }: { onNewAlbum: () => void }) {
  const t = useT();
  const { data, isLoading, error } = useQuery({ queryKey: ['albums'], queryFn: listAlbums });
  const albums = data?.items || [];
  // The collage is built from the family's own cover art, never bundled demo
  // photos: this app ships to other people's servers.
  const covers = albums.map(album => album.cover_url).filter(Boolean).slice(0, 3);
  return <div className="page">
    <PageHeading title={t('albums.title')} description={t('albums.description')} />
    <Link to="/collections" className="collection-banner">
      <span className="banner-copy"><span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-soft text-secondary text-[10px]"><Images className="w-3.5 h-3.5" />{t('albums.bannerBadge')}</span><strong className="block text-[24px] leading-[1.5] font-medium tracking-tight mt-3 mb-2 text-ink">{t('albums.bannerTitle')}</strong><span className="block text-secondary text-xs leading-6">{t('albums.bannerText')}</span><span className="inline-flex items-center gap-1.5 mt-4 text-ink text-xs font-medium">{t('albums.bannerCta')} <ArrowUpRight className="w-3.5 h-3.5" /></span></span>
      {covers.length > 0 && <span className="banner-collage" data-count={covers.length} aria-hidden="true">
        {covers.map((cover, index) => <span key={index} className={`collage-photo collage-slot-${index + 1}`}><img src={cover} alt="" loading="lazy" /></span>)}
        <span className="collage-note"><Heart className="w-4 h-4" /> {t('albums.bannerNote')}</span>
      </span>}
    </Link>
    <div className="flex items-center justify-between gap-3 mb-5"><div className="flex items-center gap-2.5"><h2 className="text-lg font-medium">{t('albums.mine')}</h2><span className="text-[11px] text-muted bg-soft px-2 py-0.5 rounded">{albums.length}</span></div></div>
    {isLoading ? <Loading /> : error ? <Empty icon={<Image className="w-8 h-8" />} title={t('albums.loadError')} description={error.message} /> : albums.length ? <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-x-3.5 sm:gap-x-5 gap-y-7">{albums.map(album => <AlbumCard key={album.id} album={album} />)}<button className="aspect-square flex flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-line text-muted text-xs hover:bg-soft hover:text-ink hover:border-ink/40" onClick={onNewAlbum}><FolderPlus className="w-6 h-6" />{t('albums.createInline')}</button></div> : <Empty icon={<Images className="w-8 h-8" />} title={t('albums.emptyTitle')} description={t('albums.emptyText')} action={<button className="btn btn-primary" onClick={onNewAlbum}><Plus className="icon" />{t('nav.newAlbum')}</button>} />}
    <footer className="mt-11 pt-5 border-t border-line/70 text-[11px] text-muted">{t('albums.footer')}</footer>
    <style>{`
      /* The tilted stack is decorative, so it is absolutely positioned and bleeds
         into the banner padding. The copy therefore reserves its width with
         --collage-reserve, which every breakpoint updates together with the scale:
         a transform cannot shrink an absolutely positioned element's layout box. */
      .collection-banner{--collage-scale:1;--collage-reserve:472px;position:relative;display:flex;align-items:center;overflow:hidden;min-height:222px;padding:27px 31px;margin-bottom:33px;border:1px solid var(--color-line);border-radius:17px;background:var(--color-soft);isolation:isolate}
      .collection-banner:hover{border-color:var(--color-muted)}
      .banner-copy{position:relative;z-index:2;min-width:0;max-width:calc(100% - var(--collage-reserve))}
      .banner-collage{position:absolute;right:26px;top:0;bottom:0;width:440px;z-index:1;pointer-events:none;transform:scale(var(--collage-scale));transform-origin:right center}
      .collage-photo{position:absolute;width:143px;height:171px;border:5px solid var(--color-surface);border-radius:11px;overflow:hidden;background:var(--color-soft);box-shadow:0 8px 22px #0a0a0a1a}
      .collage-photo img{display:block;width:100%;height:100%;object-fit:cover}
      .collage-slot-1{left:2px;top:36px;transform:rotate(-10deg)}
      .collage-slot-2{left:122px;top:17px;width:157px;height:188px;transform:rotate(4deg);z-index:1}
      .collage-slot-3{left:268px;top:41px;height:166px;transform:rotate(11deg)}
      /* Fewer than three covers: re-centre instead of leaving a hole on the left. */
      .banner-collage[data-count="2"] .collage-slot-1{left:46px}
      .banner-collage[data-count="2"] .collage-slot-2{left:178px}
      .banner-collage[data-count="1"] .collage-slot-1{left:132px;top:24px;width:157px;height:188px;transform:rotate(-4deg)}
      .collage-note{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:8px;min-width:250px;justify-content:center;padding:10px 14px;border:1px solid var(--color-line);border-radius:11px;background:color-mix(in srgb,var(--color-surface) 80%,transparent);color:var(--color-secondary);font-size:11px;white-space:nowrap;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);box-shadow:0 6px 16px #0a0a0a14}
      @media(max-width:1150px){.collection-banner{--collage-scale:.8;--collage-reserve:395px;padding-left:25px}}
      @media(max-width:900px){.collection-banner{--collage-scale:.62;--collage-reserve:310px}.banner-collage{opacity:.7}.collage-note{display:none}}
      @media(max-width:700px){.collection-banner{display:none}}
    `}</style>
  </div>;
}
export function AlbumCard({ album }: { album: Album }) {
  const t = useT();
  return <article className="min-w-0"><Link to="/albums/$albumID" params={{ albumID: album.id }} className="block relative aspect-square overflow-hidden rounded-xl bg-soft" aria-label={t('albums.openLabel', { name: album.name })}>
    {album.cover_url ? <img className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 hover:scale-[1.035]" src={album.cover_url} alt={t('albums.coverAlt', { name: album.name })} loading="lazy" /> : <span className="w-full h-full grid place-items-center text-muted"><Images className="w-8 h-8" /></span>}
    <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#172b32a3] border border-white/20 text-white text-[10px]"><Image className="w-3 h-3" />{t('albums.countBadge', { count: album.photo_count })}</span>{album.shared && <span className="absolute top-2 right-2 w-7 h-7 grid place-items-center rounded-full bg-white/85 text-secondary"><Link2 className="w-3.5 h-3.5" /></span>}
  </Link><div className="pt-3 px-0.5"><h3 className="text-[13px] sm:text-sm font-medium truncate">{album.name}</h3><p className="text-[10px] sm:text-[11px] text-muted mt-1">{album.shared ? t('albums.shared') : t('albums.private')}</p></div></article>;
}

export function PhotosPage({ albumID, onUpload, onShare, guestToken = '', guestAlbum, guestPhotos, canSetCover = false, canEditAlbum = false, canTrash = false, onTrash, onDeleteAlbum, onToast }: {
  albumID?: string; onUpload?: () => void; onShare?: () => void; guestToken?: string;
  guestAlbum?: () => Promise<Album>; guestPhotos?: () => Promise<{ items: Photo[]; urls: Record<string, string>; next_cursor: string }>;
  canSetCover?: boolean; canEditAlbum?: boolean; canTrash?: boolean; onTrash?: (ids: string[]) => void;
  onDeleteAlbum?: () => void; onToast?: (message: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const client = useQueryClient();
  useHeaderBack(albumID && !guestToken ? '/albums' : '');
  useHeaderDownload(albumID && !guestToken ? albumID : '');
  useHeaderShare(albumID && !guestToken && onShare ? albumID : '');
  const { data: album } = useQuery({ queryKey: ['album', albumID, guestToken], queryFn: () => guestAlbum ? guestAlbum() : getAlbum(albumID!), enabled: !!albumID });
  const titleRef = usePageTitleScroll(album?.name || t('photos.title'));
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['photos', albumID || 'all', guestToken], queryFn: () => guestPhotos ? guestPhotos() : listPhotos(albumID) });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<number | null>(null);
  const [download, setDownload] = useState(false);
  const [editing, setEditing] = useState(false);
  const photos = data?.items || [];
  useEffect(() => { setSelected(new Set()); setSelecting(false); }, [albumID]);
  useEffect(() => {
    if (!selecting) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelecting(false); setSelected(new Set()); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [selecting]);
  const targetAlbum = albumID || album?.id || '';
  const takenRange = album ? formatTakenRange(album.taken_from, album.taken_to, locale) : '';
  const select = (id: string) => setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const startSelection = (id: string) => { setSelecting(true); setSelected(new Set([id])); };
  const finishSelection = () => { setSelecting(false); setSelected(new Set()); };
  const setCover = async (photo: Photo) => {
    if (!albumID) return;
    try {
      await setAlbumCover(albumID, photo.id);
      await Promise.all([client.invalidateQueries({ queryKey: ['albums'] }), client.invalidateQueries({ queryKey: ['album', albumID] })]);
      onToast?.(t('albums.coverUpdated'));
    } catch (reason) { onToast?.(reason instanceof Error ? reason.message : t('albums.coverFailed')); }
  };
  const albumSaved = async () => {
    setEditing(false);
    await Promise.all([client.invalidateQueries({ queryKey: ['albums'] }), client.invalidateQueries({ queryKey: ['album', albumID] })]);
    onToast?.(t('albums.updated'));
  };
  return <div className="page">
    <div className="flex items-start sm:items-center justify-between gap-5 mb-7"><div className="min-w-0" ref={titleRef}><h1 className="page-title">{album?.name || t('photos.title')}<span className="text-accent">.</span></h1><p className="page-description">{album?.description || t('photos.description')}</p></div><div className="flex gap-2 shrink-0 pt-3">{canEditAlbum && album && <button className="btn btn-secondary" onClick={() => setEditing(true)}><Pencil className="icon" />{t('albums.edit')}</button>}{onDeleteAlbum && <button className="btn btn-secondary text-[#a25142]" onClick={onDeleteAlbum}><Trash2 className="icon" />{t('albums.delete')}</button>}</div></div>
    {album && <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted mb-6 -mt-3"><span className="inline-flex items-center gap-1.5"><Image className="w-3.5 h-3.5" />{t('photos.count', { count: album.photo_count })}</span>{takenRange && <span className="inline-flex items-center gap-1.5" title={t('photos.takenRange', { range: takenRange })}><CalendarRange className="w-3.5 h-3.5" />{takenRange}</span>}<span className="inline-flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5" />{guestToken ? t('photos.guest') : album.shared ? t('albums.shared') : t('albums.private')}</span></div>}
    {isLoading ? <Loading rows={2} /> : error ? <Empty icon={<Image className="w-8 h-8" />} title={t('photos.loadError')} description={error.message} action={<button className="btn btn-secondary" onClick={() => refetch()}>{t('common.retry')}</button>} /> : photos.length ? <PhotoGrid photos={photos} urls={data?.urls || {}} selecting={selecting} selected={selected} onSelect={select} onStartSelection={startSelection} onOpen={setViewer} onSetCover={canSetCover && albumID ? setCover : undefined} onTrash={canTrash ? photo => onTrash?.([photo.id]) : undefined} /> : <Empty icon={<Image className="w-8 h-8" />} title={t('photos.emptyTitle')} description={albumID ? t('photos.emptyAlbum') : t('photos.emptyAll')} action={onUpload && <button className="btn btn-secondary" onClick={onUpload}><ArrowUpFromLine className="icon" />{t('photos.chooseUpload')}</button>} />}
    {selecting && <div className="selection-bar glass"><span className="text-xs font-medium">{selected.size ? t('photos.selected', { count: selected.size }) : t('photos.select')}</span><button className="text-xs text-accent" onClick={() => setSelected(selected.size === photos.length ? new Set() : new Set(photos.map(photo => photo.id)))}>{selected.size === photos.length ? t('photos.deselectAll') : t('photos.selectAll')}</button><button className="btn btn-primary" disabled={!selected.size} onClick={() => setDownload(true)}><ArrowDownToLine className="icon" />{t('photos.download')}</button>{canTrash && <button className="btn btn-secondary text-[#a25142]" disabled={!selected.size} onClick={() => { onTrash?.([...selected]); finishSelection(); }}><Trash2 className="icon" />{t('photos.trash')}</button>}<button className="icon-btn" onClick={finishSelection} aria-label={t('photos.cancelSelection')}><X className="icon" /></button></div>}
    {viewer !== null && <PhotoViewer photos={photos} initialIndex={viewer} onClose={() => setViewer(null)} guestToken={guestToken} />}
    {download && targetAlbum && <DownloadDialog albumID={targetAlbum} photoIDs={[...selected]} guestToken={guestToken} onClose={() => setDownload(false)} />}
    {editing && album && <EditAlbumDialog album={album} onClose={() => setEditing(false)} onSaved={albumSaved} />}
    <style>{`.selection-bar{position:fixed;left:calc(50% + 116px);bottom:24px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:12px;padding:9px 10px 9px 18px;border:1px solid #ffffffb0;border-radius:13px;box-shadow:0 10px 36px #2342471c;white-space:nowrap}.selection-bar .btn{min-height:36px;font-size:12px}.selection-bar .icon-btn{width:38px;height:38px}@media(max-width:1023px){.selection-bar{left:50%;bottom:91px;gap:8px;padding-left:12px;max-width:calc(100vw - 28px)}.selection-bar .btn{font-size:11px}}`}</style>
  </div>;
}

/**
 * Rename an album and rewrite its one-line intro.
 *
 * Editing is admin-only on the server (`PATCH /albums/{id}` is behind
 * `requireAdmin`), so the entry point is gated by the same role. The cover is a
 * separate action with its own endpoint; it is not part of this form.
 */
function EditAlbumDialog({ album, onClose, onSaved }: { album: Album; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(album.name);
  const [description, setDescription] = useState(album.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = name.trim() !== album.name || description !== album.description;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed) { onClose(); return; }
    setBusy(true); setError('');
    try {
      await updateAlbum(album.id, { name: name.trim(), description });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('albums.saveFailed'));
      setBusy(false);
    }
  }
  return <Dialog title={t('albums.editTitle')} description={t('albums.editDescription')} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="album-edit-name">{t('newAlbum.name')}</label>
      <input className="field" id="album-edit-name" value={name} onChange={event => setName(event.target.value)} required maxLength={40} placeholder={t('newAlbum.namePlaceholder')} autoFocus disabled={busy} />
      <label className="field-label" htmlFor="album-edit-description">{t('newAlbum.descriptionLabel')} <span>{t('common.optional')}</span></label>
      <input className="field" id="album-edit-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={120} placeholder={t('newAlbum.descriptionPlaceholder')} disabled={busy} />
      {error && <p className="text-xs text-[#a25142] mt-4">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !name.trim() || !changed}>{busy ? <LoaderCircle className="icon animate-spin" /> : <Pencil className="icon" />}{t('common.save')}</button>
      </div>
    </form>
  </Dialog>;
}

export function DownloadDialog({ albumID, photoIDs, guestToken = '', onClose }: { albumID: string; photoIDs: string[]; guestToken?: string; onClose: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [jobID, setJobID] = useState('');
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!jobID || job?.status === 'succeeded' || job?.status === 'failed' || job?.status === 'cancelled') return;
    const timer = setInterval(() => { getDownload(jobID, guestToken).then(setJob).catch(reason => setError(reason.message)); }, 1500);
    return () => clearInterval(timer);
  }, [jobID, guestToken, job?.status]);
  async function start() {
    setBusy(true); setError('');
    try { const result = await createDownload({ album_id: albumID, photo_ids: photoIDs, mode }, guestToken); setJobID(result.id); setJob(await getDownload(result.id, guestToken)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('download.failed')); }
    finally { setBusy(false); }
  }
  return <Dialog title={t('download.title')} description={photoIDs.length ? t('download.descriptionCount', { count: photoIDs.length }) : t('download.descriptionAll')} onClose={onClose}>
    {!jobID ? <><div className="space-y-3">{[['single', t('download.singleTitle'), t('download.singleText')], ['batch', t('download.batchTitle'), t('download.batchText')]].map(([value,title,text]) => <label key={value} className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer ${mode === value ? 'border-accent bg-accent-soft' : 'border-line'}`}><input type="radio" name="mode" className="accent-ink" checked={mode === value} onChange={() => setMode(value as 'single' | 'batch')} /><Package className="icon text-accent" /><span className="flex-1"><strong className="block text-[13px] font-medium">{title}</strong><small className="block text-[11px] text-muted mt-1">{text}</small></span></label>)}</div><Note>{t('download.note')}</Note>{error && <p className="text-xs text-[#a25142] mt-4">{error}</p>}<div className="dialog-actions"><button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button><button className="btn btn-primary" onClick={start} disabled={busy}>{busy ? <LoaderCircle className="icon animate-spin" /> : <ArrowDownToLine className="icon" />}{t('download.start')}</button></div></> : <div className="py-3 text-center"><span className="w-14 h-14 mx-auto grid place-items-center rounded-full bg-accent-soft text-accent mb-5">{job?.status === 'succeeded' ? <Package className="w-7 h-7" /> : <LoaderCircle className="w-7 h-7 animate-spin" />}</span><h3 className="text-lg font-medium">{job?.status === 'succeeded' ? t('download.ready') : job?.status === 'failed' ? t('download.failedStatus') : t('download.running')}</h3><p className="text-xs text-muted mt-3 leading-6">{job?.status === 'succeeded' ? t('download.readyHint') : job?.error || t('download.runningHint')}</p>{job && job.status !== 'succeeded' && <div className="h-1.5 bg-soft rounded-full overflow-hidden mt-6"><div className="h-full bg-accent transition-all" style={{ width: `${job.progress}%` }} /></div>}{job?.status === 'succeeded' && <div className="mt-6 space-y-2">{job.packages.map(item => <button key={item.id} className="btn btn-primary w-full" onClick={async () => { const result = await signDownload(job.id, item.id, guestToken); window.location.assign(result.url); }}><ArrowDownToLine className="icon" />{t('download.part', { part: item.part, count: item.file_count })}</button>)}</div>}{error && <p className="text-xs text-[#a25142] mt-4">{error}</p>}<button className="btn btn-secondary mt-6" onClick={onClose}>{t('common.close')}</button></div>}
  </Dialog>;
}
