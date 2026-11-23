import { useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { emptyTrash, formatSize, listTrash, restorePhotos } from '../lib/api';
import { Empty, Loading } from './ui';
import { useLocale, useT } from '../lib/i18n';
import { useHeaderBack, usePageTitleScroll } from './HeaderTitleContext';

export function TrashPage({ canPurge, onToast }: { canPurge: boolean; onToast: (message: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const client = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['trash'], queryFn: () => listTrash() });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const titleRef = usePageTitleScroll(t('trash.title'));
  useHeaderBack('');
  const items = data?.items || [];

  useEffect(() => { setSelected(new Set()); }, [data]);

  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['trash'] }),
      client.invalidateQueries({ queryKey: ['photos'] }),
      client.invalidateQueries({ queryKey: ['albums'] }),
      client.invalidateQueries({ queryKey: ['album'] }),
    ]);
    setSelected(new Set());
  }

  async function restore(ids: string[]) {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const result = await restorePhotos(ids);
      await refresh();
      // Restoring the album too is the whole point: a photo whose album is gone
      // would stay invisible and look like the restore failed.
      onToast(result.albums_restored
        ? t('trash.restoredWithAlbums', { count: result.restored, albums: result.albums_restored })
        : t('trash.restored', { count: result.restored }));
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : t('trash.restoreFailed'));
    } finally { setBusy(false); }
  }

  async function purge() {
    if (busy || !canPurge) return;
    if (!window.confirm(t('trash.emptyConfirm', { count: data?.total_count || 0 }))) return;
    setBusy(true);
    try {
      const result = await emptyTrash();
      await refresh();
      onToast(result.failed ? t('trash.emptiedPartial', { count: result.purged, failed: result.failed }) : t('trash.emptied', { count: result.purged }));
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : t('trash.emptyFailed'));
    } finally { setBusy(false); }
  }

  const retention = data?.retention_days || 0;
  const expires = data?.expires_at ? new Date(data.expires_at) : null;
  const fmt = (value: Date) => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(value);

  return <div className="page">
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5 mb-6">
      <div ref={titleRef}>
        <h1 className="page-title">{t('trash.title')}<span className="text-accent">.</span></h1>
        <p className="page-description">{t('trash.description')}</p>
      </div>
      {canPurge && items.length > 0 && <button className="btn btn-secondary text-[#a25142] shrink-0" onClick={purge} disabled={busy}>
        <Trash2 className="icon" />{t('trash.empty')}
      </button>}
    </div>

    {data && data.total_count > 0 && <div className="panel px-4 py-3 mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-secondary">
      <span>{t('trash.count', { count: data.total_count })}</span>
      <span>{t('trash.size', { size: formatSize(data.total_bytes) })}</span>
      <span>{retention > 0 ? t('trash.retentionDays', { days: retention }) : t('trash.retentionForever')}</span>
      {expires && <span className="text-muted">{t('trash.expiresAt', { date: fmt(expires) })}</span>}
    </div>}

    {isLoading ? <Loading rows={2} /> : items.length ? <>
      <div className="photo-grid">{items.map(item => <button key={item.id} className={`photo-tile ${selected.has(item.id) ? 'selected' : ''}`} onClick={() => toggle(item.id)} aria-pressed={selected.has(item.id)} aria-label={t('trash.selectPhoto', { name: item.name })}>
        {item.thumb_url ? <img src={item.thumb_url} alt={item.name} loading="lazy" draggable={false} /> : <span className="photo-fallback" />}
        {(item.deleted_by || item.contributor) && <span className="photo-contributor">{item.deleted_by || item.contributor}</span>}
        <span className="photo-select-mask" aria-hidden="true" />
        <span className="photo-check">{selected.has(item.id) && <RotateCcw className="icon" />}</span>
      </button>)}</div>
      {selected.size > 0 && <div className="selection-bar glass">
        <span className="text-xs font-medium">{t('photos.selected', { count: selected.size })}</span>
        <button className="btn btn-primary" disabled={busy} onClick={() => restore([...selected])}>
          {busy ? <LoaderCircle className="icon animate-spin" /> : <Undo2 className="icon" />}{t('trash.restore')}
        </button>
        <button className="icon-btn" onClick={() => setSelected(new Set())} aria-label={t('photos.cancelSelection')}><X className="icon" /></button>
      </div>}
      <style>{`.selection-bar{position:fixed;left:calc(50% + 116px);bottom:24px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:12px;padding:9px 10px 9px 18px;border:1px solid #ffffffb0;border-radius:13px;box-shadow:0 10px 36px #2342471c;white-space:nowrap}.selection-bar .btn{min-height:36px;font-size:12px}@media(max-width:1023px){.selection-bar{left:50%;bottom:91px;gap:8px;padding-left:12px;max-width:calc(100vw - 28px)}.selection-bar .btn{font-size:11px}}.photo-check{border:0;background:transparent}`}</style>
    </> : <Empty icon={<Trash2 className="w-8 h-8" />} title={t('trash.emptyTitle')} description={t('trash.emptyText')} />}
  </div>;
}
