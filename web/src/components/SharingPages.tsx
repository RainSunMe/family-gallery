import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, Images, Inbox, Link2, LoaderCircle, Plus, QrCode, ShieldCheck } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import type { Album, Collection } from '../lib/api';
import { copyText, createCollection, createShare, formatDate, getCollection, listCollections, listShares, revokeShare } from '../lib/api';
import { Dialog, Empty, Loading, Select } from './ui';
import { PageHeading } from './LibraryPages';
import { useLocale, useT } from '../lib/i18n';

export function CollectionCard({ collection, onInvite }: { collection: Collection; onInvite: (collection: Collection) => void }) {
  const t = useT();
  return <article className="panel overflow-hidden"><Link to="/collections/$collectionID" params={{ collectionID: collection.id }} className="block relative h-[165px] overflow-hidden bg-soft">{collection.photos[0]?.url ? <img className="w-full h-full object-cover" src={collection.photos[0].url} alt={collection.name} /> : <span className="w-full h-full grid place-items-center text-muted"><Inbox className="w-8 h-8" /></span>}<span className="absolute inset-0 bg-gradient-to-t from-[#142f34a0] to-transparent" /><span className={`absolute top-4 left-4 status ${collection.status === 'ended' ? 'is-ended' : ''}`}><i />{collection.status === 'active' ? t('collection.active') : t('sharing.endedBadge')}</span><div className="absolute bottom-4 left-4 right-4 text-white flex items-end justify-between"><div><h3 className="text-[19px] font-medium">{collection.name}</h3><p className="text-[11px] mt-1.5 text-white/80">{collection.description}</p></div><ArrowUpRight className="icon" /></div></Link><div className="p-5"><div className="grid grid-cols-3 gap-4"><Stat value={collection.photo_count} unit={t('sharing.receivedUnit')} label={t('sharing.receivedLabel')} /><Stat value={collection.contributors.length} unit={t('sharing.familyUnit')} label={t('sharing.recording')} /><Stat value={collection.pending_count} unit={t('sharing.pendingUnit')} label={t('sharing.pendingLabel')} /></div><div className="flex items-center gap-2.5 text-[11px] text-muted mt-5 mb-4"><div className="flex-1 h-1 bg-soft rounded-full"><div className="h-full bg-accent rounded-full" style={{ width: `${collection.photo_count ? collection.imported_count / collection.photo_count * 100 : 0}%` }} /></div>{t('sharing.importedCount', { count: collection.imported_count })}</div><div className="flex gap-2 pt-4 border-t border-line/70">{collection.status === 'active' && <button className="btn btn-primary flex-1" onClick={() => onInvite(collection)}><QrCode className="icon" />{t('sharing.invite')}</button>}<Link to="/collections/$collectionID" params={{ collectionID: collection.id }} className="btn btn-secondary flex-1">{t('sharing.viewPhotos')}<ArrowRight className="icon" /></Link></div></div></article>;
}
function Stat({ value, unit, label }: { value: number; unit: string; label: string }) { return <div><strong className="text-[23px] font-medium">{value}<small className="text-[11px] font-normal text-muted ml-1">{unit}</small></strong><span className="block text-[11px] text-muted mt-1">{label}</span></div>; }

/**
 * A QR code on its own white card.
 *
 * Two reasons this is not a bare `<svg>`: a scanner needs a light quiet zone
 * around the modules (the padding plus `marginSize` provide it), and on the dark
 * surface a white card is the only thing that gives the code an edge at all.
 * The corners are rounded on the card, never on the SVG, so the finder patterns
 * are not clipped.
 */
function QrCard({ value, size }: { value: string; size: number }) {
  return <div className="qr-card w-fit">
    <QRCodeSVG value={value} size={size} fgColor="#0a0a0a" bgColor="#ffffff" level="M" marginSize={2} />
  </div>;
}

export function CollectionsPage({ onNew }: { onNew: () => void }) {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ['collections'], queryFn: listCollections });
  const [invite, setInvite] = useState<Collection | null>(null);
  const collections = data?.items || [];
  return <div className="page"><PageHeading title={t('sharing.title')} description={t('sharing.description')} /><div className="panel flex items-center gap-3 p-5 mb-8"><span className="w-10 h-10 grid place-items-center rounded-[10px] bg-accent-soft text-accent"><Inbox className="icon" /></span><div className="flex-1"><strong className="text-[13px] font-medium">{t('sharing.noApp')}</strong><p className="text-xs text-muted mt-1 leading-6">{t('sharing.noAppText')}</p></div><span className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-accent"><ShieldCheck className="w-4 h-4" />{t('sharing.neverPublic')}</span></div><div className="flex items-center gap-2.5 mb-5"><h2 className="text-lg font-medium">{t('sharing.all')}</h2><span className="text-[11px] text-muted bg-soft px-2 py-0.5 rounded">{collections.length}</span></div>{isLoading ? <Loading rows={1} /> : collections.length ? <div className="grid lg:grid-cols-2 gap-5">{collections.map(collection => <CollectionCard key={collection.id} collection={collection} onInvite={setInvite} />)}</div> : <Empty icon={<Inbox className="w-8 h-8" />} title={t('sharing.emptyTitle')} description={t('sharing.emptyText')} action={<button className="btn btn-primary" onClick={onNew}><Plus className="icon" />{t('sharing.newRequest')}</button>} />}{invite && <InviteDialog collection={invite} onClose={() => setInvite(null)} />}</div>;
}

export function InviteDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  return <Dialog title={t('sharing.invite.title')} description={t('sharing.invite.description', { name: collection.name })} onClose={onClose}><div className="flex flex-col items-center"><QrCard value={collection.invite_url} size={164} /><span className="flex items-center gap-1.5 text-[11px] text-secondary mt-3"><QrCode className="w-3.5 h-3.5 text-accent" />{t('sharing.invite.scan')}</span><div className="w-full flex items-center gap-2 p-2 pl-3 border border-line rounded-[9px] bg-canvas mt-6"><Link2 className="w-4 h-4 text-muted" /><span className="flex-1 min-w-0 truncate text-[11px] text-secondary">{collection.invite_url}</span><button className="icon-btn border border-line" aria-label={t('sharing.invite.copy')} onClick={async () => { await copyText(collection.invite_url); setCopied(true); }}><Copy className="w-3.5 h-3.5" /></button></div><p className="text-[11px] text-muted mt-3">{collection.expires_at ? t('sharing.invite.expiry', { date: new Date(collection.expires_at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US'), count: collection.batch_limit }) : t('sharing.invite.noExpiry', { count: collection.batch_limit })}</p></div><div className="dialog-actions flex-col-reverse sm:flex-row"><Link to="/guest/collect/$token" params={{ token: collection.id }} target="_blank" className="btn btn-secondary">{t('sharing.invite.preview')}</Link><button className="btn btn-primary" onClick={async () => { await copyText(collection.invite_url); setCopied(true); }}><Copy className="icon" />{copied ? t('sharing.invite.copied') : t('sharing.invite.copy')}</button></div></Dialog>;
}

export function NewCollectionDialog({ albums, onClose, onCreated }: { albums: Album[]; onClose: () => void; onCreated: (collection: Collection) => void }) {
  const t = useT();
  const client = useQueryClient(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  // The custom Select is a button, so it cannot carry a native form value. Each one
  // keeps its own state and mirrors it into a hidden input, which leaves the
  // FormData-based submit below unchanged.
  const [albumID, setAlbumID] = useState(albums[0]?.id || '');
  const [expiryDays, setExpiryDays] = useState('30');
  const [batchLimit, setBatchLimit] = useState('20');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try { const created = await createCollection({ name: String(form.get('name') || ''), description: String(form.get('description') || ''), album_id: String(form.get('album_id')), expiry_days: Number(form.get('expiry_days')), batch_limit: Number(form.get('batch_limit')), allow_message: form.get('allow_message') === 'on' }); await client.invalidateQueries({ queryKey: ['collections'] }); const detail = await getCollection(created.id); onCreated(detail); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('sharing.newCollection.failed')); }
    finally { setBusy(false); }
  }
  return <Dialog title={t('sharing.newCollection.title')} description={t('sharing.newCollection.description')} onClose={onClose}><form onSubmit={submit}><label className="field-label" htmlFor="collection-name">{t('sharing.newCollection.topic')}</label><input className="field" id="collection-name" name="name" required maxLength={40} placeholder={t('sharing.newCollection.topicPlaceholder')} /><label className="field-label" htmlFor="collection-album">{t('sharing.newCollection.album')}</label><Select id="collection-album" value={albumID} onChange={setAlbumID} options={albums.map(album => ({ value: album.id, label: album.name }))} /><input type="hidden" name="album_id" value={albumID} /><label className="field-label" htmlFor="collection-description">{t('sharing.newCollection.message')} <span>{t('common.optional')}</span></label><textarea className="field min-h-[80px]" id="collection-description" name="description" maxLength={120} placeholder={t('sharing.newCollection.messagePlaceholder')} /><div className="grid grid-cols-2 gap-3"><div><label className="field-label" htmlFor="collection-expiry">{t('sharing.newCollection.expiry')}</label><Select id="collection-expiry" value={expiryDays} onChange={setExpiryDays} options={[{ value: '7', label: t('sharing.days', { count: 7 }) }, { value: '30', label: t('sharing.days', { count: 30 }) }, { value: '0', label: t('collection.noExpiry') }]} /><input type="hidden" name="expiry_days" value={expiryDays} /></div><div><label className="field-label" htmlFor="collection-limit">{t('sharing.newCollection.limit')}</label><Select id="collection-limit" value={batchLimit} onChange={setBatchLimit} options={[{ value: '20', label: t('sharing.photosOption', { count: 20 }) }, { value: '50', label: t('sharing.photosOption', { count: 50 }) }, { value: '100', label: t('sharing.photosOption', { count: 100 }) }]} /><input type="hidden" name="batch_limit" value={batchLimit} /></div></div><label className="flex items-center gap-3 mt-5 cursor-pointer"><input className="w-4 h-4 accent-ink" type="checkbox" name="allow_message" defaultChecked /><span><strong className="block text-xs font-medium">{t('sharing.newCollection.allowMessage')}</strong><small className="text-[11px] text-muted">{t('sharing.newCollection.allowMessageHint')}</small></span></label>{error && <p className="text-xs text-[#a25142] mt-4">{error}</p>}<div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy || !albums.length}>{busy ? <LoaderCircle className="icon animate-spin" /> : <Plus className="icon" />}{t('sharing.newCollection.submit')}</button></div></form></Dialog>;
}

/**
 * Creates a read-only link and shows it in place.
 *
 * Creating must not close the dialog: the link and its QR code are exactly what
 * the user came for, and there is no second chance to see them here (the share
 * list only offers a copy of the URL). `onCreated` therefore means "the album is
 * shared now, refresh your list" — it no longer closes anything.
 */
export function ShareDialog({ album, onClose, onCreated }: { album: Album; onClose: () => void; onCreated: (url: string) => void }) {
  const t = useT();
  const client = useQueryClient();
  const [days, setDays] = useState(30);
  const [url, setURL] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // An album can already be shared. Showing that link instead of minting a new
  // one keeps the share list from filling up with duplicates every time the
  // panel is opened.
  const { data: shares } = useQuery({ queryKey: ['shares'], queryFn: listShares });
  const existing = shares?.items.find(item => item.album_id === album.id && (!item.expires_at || new Date(item.expires_at) > new Date()));
  useEffect(() => { if (existing?.url) setURL(current => current || existing.url); }, [existing?.url]);

  async function create() {
    setBusy(true); setError('');
    try {
      const result = await createShare({ album_id: album.id, expiry_days: days });
      setURL(result.url);
      onCreated(result.url);
      void client.invalidateQueries({ queryKey: ['shares'] });
      // The user asked for a link, so hand it over straight away: the click that
      // created it is still a user gesture, which is when the clipboard works.
      await copyText(result.url);
      setCopied(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('sharing.share.createFailed'));
    } finally { setBusy(false); }
  }

  async function copy() {
    await copyText(url);
    setCopied(true);
  }

  // The lifetime is decided at creation, so once a link exists the select would
  // only be a lie: say when the link actually ends.
  const reuseExisting = !!existing?.url && url === existing.url;
  const expiryLine = reuseExisting && existing?.expires_at
    ? t('sharing.share.expiresOn', { date: formatDate(existing.expires_at) })
    : days ? t('sharing.share.expiresIn', { count: days }) : t('sharing.share.noExpiry');

  return <Dialog title={t('sharing.share.title')} description={t('sharing.share.description', { name: album.name })} onClose={onClose}>
    <div className="p-4 rounded-xl bg-accent-soft flex gap-3">
      <ShieldCheck className="icon text-accent" />
      <div><strong className="text-[13px] font-medium">{t('sharing.share.readOnly')}</strong><p className="text-[11px] text-secondary leading-6 mt-1">{t('sharing.share.readOnlyText')}</p></div>
    </div>

    {url
      ? <p className="mt-4 text-[11px] text-muted">{expiryLine}</p>
      : <>
          <label className="field-label" htmlFor="share-expiry">{t('sharing.share.expiry')}</label>
          <Select id="share-expiry" value={String(days)} onChange={value => setDays(Number(value))} disabled={busy} options={[{ value: '7', label: t('sharing.days', { count: 7 }) }, { value: '30', label: t('sharing.days', { count: 30 }) }, { value: '0', label: t('collection.noExpiry') }]} />
        </>}

    {url && <div className="mt-4">
      <label className="field-label" htmlFor="share-url">{t('sharing.share.linkLabel')}</label>
      <div className="flex items-center gap-2 p-2 pl-3 border border-line rounded-[9px] bg-canvas">
        <Link2 className="w-4 h-4 shrink-0 text-muted" />
        <input id="share-url" className="flex-1 min-w-0 border-0 bg-transparent text-[11px] text-secondary" value={url} readOnly onFocus={event => event.currentTarget.select()} />
        <button className="icon-btn border border-line" aria-label={t('sharing.share.copy')} onClick={copy}><Copy className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex justify-center mt-5"><QrCard value={url} size={150} /></div>
    </div>}

    {error && <p className="text-xs text-[#a25142] mt-4">{error}</p>}

    <div className="dialog-actions">
      <button type="button" className="btn btn-secondary" onClick={onClose}>{url ? t('common.close') : t('common.cancel')}</button>
      {url
        ? <button type="button" className="btn btn-primary" onClick={copy}>{copied ? <Check className="icon" /> : <Copy className="icon" />}{copied ? t('sharing.share.copied') : t('sharing.share.copy')}</button>
        : <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>{busy ? <LoaderCircle className="icon animate-spin" /> : <Link2 className="icon" />}{t('sharing.share.create')}</button>}
    </div>
  </Dialog>;
}

export function SharesPage({ onToast }: { onToast: (message: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const client = useQueryClient(); const { data, isLoading } = useQuery({ queryKey: ['shares'], queryFn: listShares }); const shares = data?.items || [];
  return <div className="page"><PageHeading title={t('sharing.shares.title')} description={t('sharing.shares.description')} /><div className="panel flex flex-wrap items-center gap-3 p-5 mb-8"><ShieldCheck className="w-5 h-5 text-accent" /><strong className="text-[13px] font-medium">{t('sharing.shares.scope')}</strong><span className="flex-1 min-w-[220px] text-xs text-muted leading-6">{t('sharing.shares.scopeText')}</span><span className="status"><i />{t('sharing.shares.readOnly')}</span></div><h2 className="text-lg font-medium mb-5">{t('sharing.shares.active')} <span className="text-[11px] text-muted bg-soft px-2 py-0.5 rounded ml-2">{shares.length}</span></h2>{isLoading ? <Loading rows={1} /> : shares.length ? <div className="space-y-3">{shares.map(share => <article className="panel share-row" key={share.id}><div className="share-cover">{share.album_cover_url ? <img src={share.album_cover_url} alt={t('albums.coverAlt', { name: share.album_name })} /> : <Images className="icon" />}</div><div className="flex-1 min-w-0"><div className="flex items-center gap-2"><h3 className="text-sm font-medium truncate">{share.album_name}</h3><span className="status"><i />{t('sharing.shares.badge')}</span></div><p className="text-[11px] text-muted mt-1.5">{t('sharing.shares.meta', { photos: share.photo_count, views: share.view_count, expiry: share.expires_at ? t('sharing.shares.expiry', { date: new Date(share.expires_at).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US') }) : t('sharing.shares.noExpiry') })}</p><p className="text-[11px] text-muted truncate mt-1.5">{share.url}</p></div><div className="flex gap-2"><button className="btn btn-secondary" onClick={async () => { await copyText(share.url); onToast(t('sharing.shares.copied')); }}><Copy className="icon" />{t('sharing.share.copy')}</button><button className="btn btn-secondary" onClick={async () => { if (!confirm(t('sharing.shares.stopConfirm'))) return; await revokeShare(share.id); await client.invalidateQueries({ queryKey: ['shares'] }); await client.invalidateQueries({ queryKey: ['albums'] }); onToast(t('sharing.shares.stopped')); }}>{t('sharing.shares.stop')}</button></div></article>)}</div> : <Empty icon={<Link2 className="w-8 h-8" />} title={t('sharing.shares.emptyTitle')} description={t('sharing.shares.emptyText')} />}<style>{`.share-row{display:flex;align-items:center;gap:17px;padding:14px}.share-cover{width:92px;height:76px;display:grid;place-items:center;flex-shrink:0;border-radius:10px;overflow:hidden;background:var(--color-soft);color:var(--color-muted)}.share-cover img{width:100%;height:100%;object-fit:cover}.share-row .btn{font-size:12px;min-height:38px}@media(max-width:700px){.share-row{flex-direction:column;align-items:stretch;gap:14px;padding:15px}.share-row>div:last-child{display:grid;grid-template-columns:1fr 1fr;gap:8px}.share-row .btn{width:100%}}`}</style></div>;
}
