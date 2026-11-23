import { useCallback, useEffect, useState, createContext, useContext } from 'react';
import type { FormEvent } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { LoaderCircle, Plus, Search } from 'lucide-react';
import { Shell } from './components/Shell';
import { Dialog, Toast } from './components/ui';
import { HeaderTitleProvider } from './components/HeaderTitleContext';
import { LoginPage, SettingsDialog } from './components/AuthSettings';
import { InviteDialog, NewCollectionDialog, ShareDialog } from './components/SharingPages';
import { UploadDialog } from './components/UploadDialog';
import { api, createAlbum, deleteAlbum, listAlbums, listCollections, restorePhotos, trashPhotos } from './lib/api';
import { useT } from './lib/i18n';
import type { Album, Collection, Role } from './lib/api';
import './index.css';

export function FamilyApp() {
  const t = useT();
  const [role, setRole] = useState<Role | null | 'loading'>('loading');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [newAlbum, setNewAlbum] = useState(false);
  const [newCollection, setNewCollection] = useState(false);
  const [upload, setUpload] = useState(false);
  const [settings, setSettings] = useState(false);
  const [shareAlbum, setShareAlbum] = useState<Album | null>(null);
  const [invite, setInvite] = useState<Collection | null>(null);
  const [search, setSearch] = useState(false);
  const [toast, setToast] = useState<{ message: string; action?: { label: string; run: () => void } } | null>(null);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('cg-theme') === 'dark'; } catch { return false; } });
  const client = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: state => state.location.pathname });
  const refreshAlbums = useCallback(async () => { const result = await listAlbums(); setAlbums(result.items); }, []);
  const notify = useCallback((message: string) => setToast({ message }), []);
  const deleteWholeAlbum = useCallback(async (albumID: string) => {
    const album = albums.find(item => item.id === albumID);
    if (!album || !window.confirm(t('albums.deleteConfirm', { name: album.name }))) return;
    try {
      await deleteAlbum(albumID);
      client.invalidateQueries(); await refreshAlbums();
      navigate({ to: '/albums' });
      setToast({
        message: t('albums.deleted', { name: album.name }),
        action: {
          label: t('trash.undo'),
          run: () => { /* restoring the album means restoring its photos, handled in the trash page */ navigate({ to: '/trash' }); },
        },
      });
    } catch (reason) { setToast({ message: reason instanceof Error ? reason.message : t('albums.deleteFailed') }); }
  }, [albums, client, navigate, refreshAlbums, t]);
  // Moving photos to the trash always offers undo: there are no per-user
  // accounts and no audit trail, so a wrong click would otherwise be final.
  const moveToTrash = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const result = await trashPhotos(ids);
      client.invalidateQueries(); refreshAlbums();
      setToast({
        message: t('trash.moved', { count: result.trashed }),
        action: {
          label: t('trash.undo'),
          run: () => {
            restorePhotos(ids).then(() => { client.invalidateQueries(); refreshAlbums(); setToast({ message: t('trash.restored', { count: ids.length }) }); })
              .catch(reason => setToast({ message: reason instanceof Error ? reason.message : t('trash.restoreFailed') }));
          },
        },
      });
    } catch (reason) { setToast({ message: reason instanceof Error ? reason.message : t('trash.moveFailed') }); }
  }, [client, refreshAlbums, t]);
  useEffect(() => { api<{ role: Role }>('/auth/session').then(result => setRole(result.role)).catch(() => setRole(null)); }, []);
  useEffect(() => { if (role && role !== 'loading') refreshAlbums().catch(reason => setToast({ message: reason.message })); }, [role, refreshAlbums]);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); try { localStorage.setItem('cg-theme', dark ? 'dark' : 'light'); } catch { /* storage optional */ } }, [dark]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearch(true); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  if (role === 'loading') return <main className="min-h-dvh grid place-items-center"><LoaderCircle className="w-7 h-7 animate-spin text-accent" /></main>;
  if (!role) return <LoginPage onLogin={value => { setRole(value); client.clear(); }} />;
  const initialAlbum = path.startsWith('/albums/') ? path.split('/').pop() || albums[0]?.id || '' : albums[0]?.id || '';
  return <HeaderTitleProvider><Shell role={role} albumCount={albums.length} onUpload={() => setUpload(true)} onNewAlbum={() => setNewAlbum(true)} onNewCollection={() => setNewCollection(true)} onSettings={() => setSettings(true)}>
    <FamilyActionsContext.Provider value={{ role, onUpload: () => setUpload(true), onNewAlbum: () => setNewAlbum(true), onNewCollection: () => setNewCollection(true), onShare: setShareAlbum, onTrash: moveToTrash, onDeleteAlbum: deleteWholeAlbum, onToast: notify }}>
      <Outlet />
    </FamilyActionsContext.Provider>
    {newAlbum && <NewAlbumDialog onClose={() => setNewAlbum(false)} onCreated={async album => { await refreshAlbums(); setNewAlbum(false); navigate({ to: '/albums/$albumID', params: { albumID: album.id } }); }} />}
    {upload && <UploadDialog albums={albums} initialAlbum={initialAlbum} onClose={() => setUpload(false)} onComplete={() => { client.invalidateQueries(); refreshAlbums(); }} />}
    {newCollection && <NewCollectionDialog albums={albums} onClose={() => setNewCollection(false)} onCreated={setInvite} />}
    {invite && <InviteDialog collection={invite} onClose={() => setInvite(null)} />}
    {shareAlbum && <ShareDialog album={shareAlbum} onClose={() => setShareAlbum(null)} onCreated={() => { client.invalidateQueries({ queryKey: ['albums'] }); setToast({ message: t('share.created') }); }} />}
    {settings && <SettingsDialog role={role} dark={dark} onTheme={() => setDark(value => !value)} onClose={() => setSettings(false)} onLogout={async () => { await api('/auth/logout', { method: 'POST', body: '{}' }); setRole(null); setSettings(false); }} />}
    {search && <SearchDialog onClose={() => setSearch(false)} />}
    {toast && <Toast message={toast.message} action={toast.action} onClose={() => setToast(null)} />}
  </Shell></HeaderTitleProvider>;
}
function NewAlbumDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (album: Album) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); try { const album = await createAlbum({ name: String(form.get('name') || ''), description: String(form.get('description') || '') }); onCreated(album); } catch (reason) { setError(reason instanceof Error ? reason.message : t('newAlbum.failed')); } finally { setBusy(false); } }
  return <Dialog title={t('newAlbum.title')} description={t('newAlbum.description')} onClose={onClose}><form onSubmit={submit}><label className="field-label" htmlFor="album-name">{t('newAlbum.name')}</label><input className="field" id="album-name" name="name" required maxLength={40} placeholder={t('newAlbum.namePlaceholder')} autoFocus /><label className="field-label" htmlFor="album-description">{t('newAlbum.descriptionLabel')} <span>{t('common.optional')}</span></label><input className="field" id="album-description" name="description" maxLength={120} placeholder={t('newAlbum.descriptionPlaceholder')} />{error && <p className="text-xs text-[#a25142] mt-4">{error}</p>}<div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy}>{busy ? <LoaderCircle className="icon animate-spin" /> : <Plus className="icon" />}{t('newAlbum.create')}</button></div></form></Dialog>;
}
function SearchDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [term, setTerm] = useState(''); const [albums, setAlbums] = useState<Album[]>([]); const [collections, setCollections] = useState<Collection[]>([]);
  useEffect(() => { Promise.all([listAlbums(), listCollections()]).then(([a, c]) => { setAlbums(a.items); setCollections(c.items); }); }, []);
  const results = [...albums.filter(item => `${item.name}${item.description}`.includes(term)).map(item => ({ id: item.id, name: item.name, type: t('search.typeAlbum'), url: `/albums/${item.id}` })), ...collections.filter(item => `${item.name}${item.description}`.includes(term)).map(item => ({ id: item.id, name: item.name, type: t('search.typeCollection'), url: `/collections/${item.id}` }))];
  return <Dialog title={t('search.title')} description={t('search.description')} onClose={onClose}><div className="field-leading"><Search className="icon text-accent" /><input className="field" value={term} onChange={event => setTerm(event.target.value)} placeholder={t('search.placeholder')} autoFocus /></div><div className="mt-4 max-h-[340px] overflow-auto">{results.length ? results.map(result => <a key={`${result.type}-${result.id}`} href={result.url} className="flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-soft"><span className="flex-1 text-[13px]">{result.name}</span><span className="text-[11px] text-muted">{result.type}</span></a>) : <p className="text-center text-xs text-muted py-6">{t('search.empty')}</p>}</div></Dialog>;
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } } });
export type FamilyActions = {
  role: Role;
  onUpload: () => void;
  onNewAlbum: () => void;
  onNewCollection: () => void;
  onShare: (album: Album) => void;
  onTrash: (ids: string[]) => void;
  onDeleteAlbum: (albumID: string) => void;
  onToast: (message: string) => void;
};
export const FamilyActionsContext = createContext<FamilyActions | null>(null);
export const useFamilyActions = () => {
  const actions = useContext(FamilyActionsContext);
  if (!actions) throw new Error('Family actions require the family layout');
  return actions;
};
