import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FileImage, FolderOpen, ImagePlus, LoaderCircle, UploadCloud } from 'lucide-react';
import { Dialog, Note, Select } from './ui';
import { formatSize } from '../lib/api';
import type { Album } from '../lib/api';
import { useT } from '../lib/i18n';
import { UPLOAD_ACCEPT } from '../lib/decode';
import { canPickDirectory, DirectorySource, FileListSource, isPreviewableName, pickDirectory, type SourceEntry, type UploadSource } from '../lib/queue/source';
import { enqueue, mobileLimit } from '../lib/queue/runner';

/** Rows painted at once; a 4000-photo folder still has to open in a blink. */
const LIST_LIMIT = 200;

/**
 * Chooses what to add, then hands the batch to the queue.
 *
 * Picking a folder is only the first half: a family library holds far more than
 * anyone wants to upload, so after listing we show every photo found (subfolders
 * included) and let the user tick the ones they mean. The dialog itself never
 * uploads — it only produces a source plus the chosen entries.
 */
export function UploadSourceDialog({ albums, initialAlbum, onClose, onQueued }: {
  albums: Album[];
  initialAlbum: string;
  onClose: () => void;
  onQueued: (count: number) => void;
}) {
  const t = useT();
  const [albumID, setAlbumID] = useState(initialAlbum || albums[0]?.id || '');
  const [source, setSource] = useState<UploadSource | null>(null);
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);

  const chosen = useMemo(() => entries.filter((_, index) => selected.has(index)), [entries, selected]);
  const totalBytes = chosen.reduce((sum, entry) => sum + entry.size, 0);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const rows = entries.map((entry, index) => ({ entry, index }));
    return term ? rows.filter(({ entry }) => (entry.path || entry.name).toLowerCase().includes(term)) : rows;
  }, [entries, filter]);
  const shown = showAll ? visible : visible.slice(0, LIST_LIMIT);

  function adopt(next: UploadSource, nextEntries: SourceEntry[]) {
    setSource(next);
    setEntries(nextEntries);
    // Everything is ticked by default: picking a folder is already a statement
    // of intent, and unticking a few is less work than ticking hundreds.
    setSelected(new Set(nextEntries.map((_, index) => index)));
    setFilter('');
    setShowAll(false);
    setError('');
    setNotice(nextEntries.length ? '' : t('queue.noneFound'));
  }

  function reset() {
    setSource(null);
    setEntries([]);
    setSelected(new Set());
    setFilter('');
    setShowAll(false);
    setError('');
    setNotice('');
  }

  async function chooseFolder() {
    setBusy(true);
    setError('');
    try {
      const directory = await pickDirectory('gallery-upload-source');
      if (!directory) return;
      const next = new DirectorySource(directory);
      adopt(next, await next.list());
    } catch (reason) {
      // AbortError means the user dismissed the picker; anything else is real.
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof Error ? reason.message : t('queue.failedGeneric'));
      }
    } finally { setBusy(false); }
  }

  async function chooseFiles(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      const next = new FileListSource(files);
      adopt(next, await next.list());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('queue.failedGeneric'));
    } finally { setBusy(false); }
  }

  function toggle(index: number) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(previous => {
      const next = new Set(previous);
      for (const { index } of visible) next.add(index);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!albumID || !source || !chosen.length) return;
    setBusy(true);
    try {
      const created = await enqueue(crypto.randomUUID(), albumID, source, chosen);
      onQueued(created.length);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('queue.failedGeneric'));
      setBusy(false);
    }
  }

  const openEntry = useCallback((entry: SourceEntry) => {
    if (!source) return Promise.reject(new Error('missing source'));
    return source.open(entry);
  }, [source]);

  const limit = mobileLimit(chosen);
  const limitNotice = limit === 'files' ? t('queue.mobileFiles', { count: 100 }) : limit === 'bytes' ? t('queue.mobileBytes', { size: '500 MB' }) : '';
  // `formatSize(0)` rounds up to "1 KB", so the size is only shown once
  // something is actually selected.
  const summary = entries.length
    ? chosen.length
      ? t('queue.selectedCount', { count: chosen.length, total: entries.length, size: formatSize(totalBytes) })
      : t('queue.selectedNone', { total: entries.length })
    : t('queue.pickedNone');

  return <Dialog wide title={t('queue.pickTitle')} description={t('queue.pickDescription')} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="queue-album">{t('uploadDialog.album')}</label>
      <Select
        id="queue-album"
        value={albumID}
        onChange={setAlbumID}
        disabled={busy}
        options={albums.map(album => ({ value: album.id, label: album.name }))}
      />

      {!entries.length ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          {/* Chromium can remember a folder; elsewhere a folder still selects in one gesture. */}
          <button type="button" className="btn btn-secondary flex-col" style={{ minHeight: 92 }} onClick={canPickDirectory() ? chooseFolder : () => folderInput.current?.click()} disabled={busy}>
            {busy ? <LoaderCircle className="icon animate-spin" /> : <FolderOpen className="icon" />}
            {busy ? t('queue.listing') : t('queue.pickFolder')}
          </button>
          <label
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed p-3 text-center transition-colors ${dragging ? 'border-accent bg-accent-soft' : 'border-line bg-canvas'}`}
            style={{ minHeight: 92 }}
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void chooseFiles(Array.from(event.dataTransfer.files)); }}
          >
            <ImagePlus className="icon w-5 h-5 text-accent mb-1.5" />
            <strong className="text-xs font-medium">{t('queue.dropped')}</strong>
            <input className="sr-only" type="file" accept={UPLOAD_ACCEPT} multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void chooseFiles(files); }} />
          </label>
          <input ref={folderInput} className="sr-only" type="file" multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void chooseFiles(files); }} {...{ webkitdirectory: '', directory: '' }} />
        </div>
      ) : (
        <section className="mt-4" aria-label={t('queue.pickTitle')}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[13px] text-secondary">{t('queue.found', { count: entries.length })}</p>
            <button type="button" className="text-[11px] text-muted underline underline-offset-2 transition-colors hover:text-ink" onClick={reset} disabled={busy}>{t('queue.reselect')}</button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <input
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 text-[12px] text-ink placeholder:text-muted"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
              placeholder={t('queue.filterPlaceholder')}
              disabled={busy}
              aria-label={t('queue.filterPlaceholder')}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={selectAllVisible} disabled={busy}>{t('queue.selectAll')}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())} disabled={busy}>{t('queue.selectNone')}</button>
          </div>

          <div className="mt-2 max-h-[240px] overflow-y-auto overscroll-contain rounded-xl border border-line">
            {shown.length ? shown.map(({ entry, index }) => {
              const folder = entry.path && entry.path !== entry.name ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
              return <label key={`${entry.path || entry.name}-${index}`} className="flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-soft">
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" checked={selected.has(index)} onChange={() => toggle(index)} />
                <Thumb entry={entry} open={openEntry} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{entry.name}</span>
                  {folder && <span className="block truncate text-[11px] text-muted">{folder}</span>}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatSize(entry.size)}</span>
              </label>;
            }) : <p className="px-3 py-8 text-center text-xs text-muted">{t('queue.noMatch')}</p>}
          </div>

          {visible.length > shown.length && <button type="button" className="mt-2 text-[11px] text-muted transition-colors hover:text-ink" onClick={() => setShowAll(true)}>
            {t('queue.showAll', { count: visible.length })}
          </button>}
        </section>
      )}

      <p className="mt-3 text-xs text-secondary">{summary}</p>
      {!canPickDirectory() && !entries.length && <p className="mt-1 text-[11px] leading-5 text-muted">{t('queue.pickFolderHint')}</p>}
      {notice && <p className="mt-3 text-[11px] leading-5 text-muted">{notice}</p>}
      {error && <p className="mt-3 text-[11px] leading-5 text-[#a25142]">{error}</p>}
      {limitNotice && <p className="mt-3 text-[11px] leading-5 text-[#a2663d]">{limitNotice}</p>}

      <Note>{t('uploadDialog.note')}</Note>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('uploadDialog.close')}</button>
        <button className="btn btn-primary" disabled={!chosen.length || !albumID || !source || busy || !!error || !!limitNotice}>
          {busy ? <LoaderCircle className="icon animate-spin" /> : <UploadCloud className="icon" />}
          {chosen.length ? `${t('queue.enqueue')} · ${chosen.length}` : t('queue.enqueue')}
        </button>
      </div>
    </form>
  </Dialog>;
}

/**
 * A 36px thumbnail, decoded only when the row scrolls into view.
 *
 * A 2000-photo folder would otherwise create 2000 object URLs and decode them
 * all at once; HEIC is left to the placeholder because the browser cannot paint
 * it, and the upload pipeline decodes it later anyway.
 */
function Thumb({ entry, open }: { entry: SourceEntry; open: (entry: SourceEntry) => Promise<File> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!isPreviewableName(entry.name) || typeof IntersectionObserver !== 'function') return;
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    let created = '';
    const observer = new IntersectionObserver(records => {
      if (!records.some(record => record.isIntersecting)) return;
      observer.disconnect();
      open(entry).then(file => {
        if (cancelled) return;
        created = URL.createObjectURL(file);
        setUrl(created);
      }).catch(() => { /* keep the placeholder */ });
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (created) URL.revokeObjectURL(created);
    };
  }, [entry, open]);

  return <span ref={ref} className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-soft text-muted">
    {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setUrl('')} /> : <FileImage className="h-4 w-4" />}
  </span>;
}
