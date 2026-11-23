import { useState } from 'react';
import { Clock3, Folder, FolderInput, HardDrive, Images, Inbox, QrCode, UsersRound, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Photo } from '../lib/api';
import { closeCollection, getCollection, importCollection } from '../lib/api';
import { Empty, Loading } from './ui';
import { usePageTitleScroll, useHeaderBack } from './HeaderTitleContext';
import { PhotoGrid, PhotoViewer } from './PhotoGrid';
import { InviteDialog } from './SharingPages';
import { useI18n } from '../lib/i18n';

export function CollectionDetail({ id, onToast }: { id: string; onToast: (message: string) => void }) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const { data: collection, isLoading } = useQuery({ queryKey: ['collection', id], queryFn: () => getCollection(id) });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<number | null>(null);
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const collectionTitleRef = usePageTitleScroll(collection?.name || '');
  useHeaderBack('/collections');
  if (isLoading || !collection) return <div className="page"><Loading rows={1} /></div>;
  const photos = collection.photos;
  const urls = Object.fromEntries(photos.map(photo => [photo.id, photo.url]));
  const origins = Object.fromEntries(photos.map(photo => [photo.id, photo.status === 'imported' ? t('grid.imported') : photo.status === 'duplicate' ? t('collection.duplicateStatus') : t('collection.pending')]));
  const contributorNames = Object.fromEntries(photos.map(photo => [photo.id, photo.contributor]));
  const viewerPhotos: Photo[] = photos.map(photo => ({ ...photo, album_id: collection.album_id, taken_at: photo.created_at }));
  async function importItems(onlySelected: boolean) {
    if (!collection) return;
    const ids = onlySelected ? [...selected] : [];
    if (onlySelected && !ids.length) { onToast(t('collection.selectFirst')); return; }
    setBusy(true);
    try { const result = await importCollection(collection.id, ids); await client.invalidateQueries({ queryKey: ['collection', id] }); await client.invalidateQueries({ queryKey: ['albums'] }); await client.invalidateQueries({ queryKey: ['collections'] }); setSelected(new Set()); setSelecting(false); const extra = (result.failed ? t('collection.importedExtra', { count: result.failed }) : '') + (result.skipped_duplicates ? t('collection.duplicatesExtra', { count: result.skipped_duplicates }) : ''); onToast(t('collection.importedToast', { count: result.imported, extra })); }
    catch (reason) { onToast(reason instanceof Error ? reason.message : t('collection.importFailed')); }
    finally { setBusy(false); }
  }
  return <div className="page">
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5 mb-6"><div ref={collectionTitleRef}><h1 className="page-title">{collection.name}</h1><p className="flex items-center gap-2 mt-2 text-[11px] text-muted"><span className="collection-state"><i />{collection.status === 'active' ? t('collection.active') : t('collection.ended')}</span></p><p className="page-description">{collection.description}</p><div className="flex flex-wrap gap-4 mt-3 text-[11px] text-muted"><span className="inline-flex items-center gap-1.5"><Clock3 className="w-3.5 h-3.5" />{collection.expires_at ? t('collection.dueBy', { date: new Date(collection.expires_at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') }) : t('collection.noExpiry')}</span><span className="inline-flex items-center gap-1.5"><Folder className="w-3.5 h-3.5" />{t('collection.linkedAlbum')}</span></div></div><div className="flex gap-2 shrink-0 flex-wrap">{collection.status === 'active' && <button className="btn btn-secondary" onClick={() => setInvite(true)}><QrCode className="icon" />{t('collection.invite')}</button>}<button className="btn btn-primary" disabled={!collection.pending_count || busy} onClick={() => importItems(false)}><FolderInput className="icon" />{t('collection.import')}</button></div></div>
    {collection.status === 'active' && <div className="flex justify-end -mt-3 mb-5"><button className="text-[11px] text-muted hover:text-ink underline-offset-4 hover:underline" onClick={async () => { if (!confirm(t('collection.closeConfirm'))) return; await closeCollection(collection.id); await client.invalidateQueries({ queryKey: ['collection', id] }); onToast(t('collection.closed')); }}>{t('collection.close')}</button></div>}
    <div className="panel grid grid-cols-2 lg:grid-cols-4 py-5 mb-6"><Summary icon={<Images className="icon" />} label={t('collection.received')} value={collection.photo_count} unit={t('collection.photosUnit')} /><Summary icon={<UsersRound className="icon" />} label={t('collection.recording')} value={collection.contributors.length} unit={t('collection.contributorsUnit')} /><Summary icon={<FolderInput className="icon" />} label={t('collection.importedLabel')} value={collection.imported_count} unit={t('collection.importedUnit', { count: collection.photo_count })} /><Summary icon={<HardDrive className="icon" />} label={t('collection.totalSize')} value={(collection.photos.reduce((sum, item) => sum + item.size, 0) / 1024 / 1024).toFixed(1)} unit="MB" /></div>
    {photos.length ? <PhotoGrid photos={viewerPhotos} urls={urls} selecting={selecting} selected={selected} onSelect={id => setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; })} onStartSelection={id => { setSelecting(true); setSelected(new Set([id])); }} onOpen={setViewer} origins={origins} /> : <Empty icon={<Inbox className="w-8 h-8" />} title={collection.photo_count ? t('collection.emptyFiltered') : t('collection.emptyFirst')} description={collection.photo_count ? t('collection.emptyFilteredHint') : t('collection.emptyFirstHint')} action={collection.status === 'active' && <button className="btn btn-primary" onClick={() => setInvite(true)}><QrCode className="icon" />{t('collection.invite')}</button>} />}
    {collection.contributors.length > 0 && <section className="mt-8"><h2 className="text-base font-medium mb-4">{t('collection.summary')}</h2><div className="panel divide-y divide-line/60 px-5">{collection.contributors.map((contributor, index) => <div key={index} className="flex items-center gap-3 py-3"><span className="w-8 h-8 grid place-items-center rounded-full bg-soft text-ink"><UsersRound className="w-4 h-4" /></span><span className="flex-1 text-[13px] text-secondary">{contributor.name || t('collection.memberSubmission')}</span><span className="text-xs text-muted">{t('photos.count', { count: contributor.count ?? 0 })}</span></div>)}</div></section>}
    {selecting && <div className="selection-bar glass"><span className="text-xs font-medium">{selected.size ? t('collection.selected', { count: selected.size }) : t('collection.select')}</span><button className="text-xs text-accent" onClick={() => setSelected(selected.size === photos.length ? new Set() : new Set(photos.map(photo => photo.id)))}>{selected.size === photos.length ? t('collection.deselectAll') : t('collection.selectAll')}</button><button className="btn btn-primary" disabled={!selected.size || busy} onClick={() => importItems(true)}><FolderInput className="icon" />{t('collection.import')}</button><button className="icon-btn" onClick={() => { setSelecting(false); setSelected(new Set()); }} aria-label={t('photos.cancelSelection')}><X className="icon" /></button></div>}
    {viewer !== null && <PhotoViewer photos={viewerPhotos} initialIndex={viewer} onClose={() => setViewer(null)} contributors={contributorNames} guestToken={`collection:${collection.id}`} />}
    {invite && <InviteDialog collection={collection} onClose={() => setInvite(false)} />}
    <style>{`.collection-state{display:inline-flex;align-items:center;gap:6px;font-size:var(--text-caption);color:var(--color-ink)}.collection-state i{width:6px;height:6px;border-radius:50%;background:#16a34a}.summary-stat{padding:0 22px;border-right:1px solid var(--color-line)}.summary-stat:last-child{border:0}.summary-stat>span{display:flex;align-items:center;gap:6px;color:var(--color-muted);font-size:11px;margin-bottom:7px}.summary-stat strong{font-size:26px;font-weight:550}.summary-stat small{font-size:11px;color:var(--color-muted);font-weight:400;margin-left:5px}.selection-bar{position:fixed;left:calc(50% + 116px);bottom:24px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:12px;padding:9px 10px 9px 18px;border:1px solid #ffffffb0;border-radius:13px;box-shadow:0 10px 36px #2342471c;white-space:nowrap}.selection-bar .btn{min-height:36px;font-size:12px}@media(max-width:1023px){.selection-bar{left:50%;bottom:91px;gap:8px;padding-left:12px;max-width:calc(100vw - 28px)}.selection-bar .btn{font-size:11px}.summary-stat{padding:12px 16px}.summary-stat:nth-child(2){border-right:0}.summary-stat:nth-child(3),.summary-stat:nth-child(4){border-top:1px solid var(--color-line)}}`}</style>
  </div>;
}
function Summary({ icon, label, value, unit }: { icon: React.ReactNode; label: string; value: number | string; unit: string }) { return <div className="summary-stat"><span>{icon}{label}</span><strong>{value}<small>{unit}</small></strong></div>; }
