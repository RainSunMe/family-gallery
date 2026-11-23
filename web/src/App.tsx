import { useEffect, useState } from 'react';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { LoaderCircle, Search } from 'lucide-react';
import { FamilyApp, queryClient, useFamilyActions } from './FamilyApp';
import { AlbumsPage, PhotosPage } from './components/LibraryPages';
import { CollectionsPage, SharesPage } from './components/SharingPages';
import { CollectionDetail } from './components/CollectionDetail';
import { GuestCollectionPage } from './components/GuestCollectionPage';
import { Empty } from './components/ui';
import { guestAlbum, guestPhotos, listAlbums } from './lib/api';
import type { Album } from './lib/api';
import { SiteProvider } from './lib/site';
import { I18nProvider, useT } from './lib/i18n';
import './index.css';
import './viewer.css';

const familyRoute = createRoute({ getParentRoute: () => rootRoute, id: 'family', component: FamilyApp });

function AlbumsRoute() { const actions = useFamilyActions(); return <AlbumsPage onNewAlbum={actions.onNewAlbum} />; }
function PhotosRoute() { const actions = useFamilyActions(); return <PhotosPage onUpload={actions.onUpload} />; }
function AlbumRoute() {
  const { albumID } = albumDetailRoute.useParams();
  const actions = useFamilyActions();
  return <PhotosPage albumID={albumID} onUpload={actions.onUpload} onShare={() => listAlbums().then(result => { const album = result.items.find(item => item.id === albumID); if (album) actions.onShare(album); })} canSetCover={actions.role === 'admin'} onToast={actions.onToast} />;
}
function CollectionsRoute() { const actions = useFamilyActions(); return <CollectionsPage onNew={actions.onNewCollection} />; }
function CollectionRoute() { const { collectionID } = collectionDetailRoute.useParams(); const actions = useFamilyActions(); return <CollectionDetail id={collectionID} onToast={actions.onToast} />; }
function SharesRoute() { const actions = useFamilyActions(); return <SharesPage onToast={actions.onToast} />; }
function GuestShareRoute() {
  const t = useT();
  const { token } = guestShareRoute.useParams();
  const [album, setAlbum] = useState<Album | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { guestAlbum(token).then(setAlbum).catch(reason => setError(reason.message)); }, [token]);
  if (error) return <main className="min-h-dvh grid place-items-center p-6"><Empty icon={<Search className="w-8 h-8" />} title={t('guest.shareUnavailable')} description={t('guest.shareUnavailableHint')} /></main>;
  if (!album) return <main className="min-h-dvh grid place-items-center"><LoaderCircle className="w-7 h-7 animate-spin text-accent" /></main>;
  return <><div className="fixed left-1/2 -translate-x-1/2 top-3 z-20 px-4 py-2 rounded-full bg-surface/80 backdrop-blur-xl border border-line text-xs text-secondary shadow-sm">{t('guest.readOnly')}</div><PhotosPage albumID={album.id} guestToken={token} guestAlbum={() => Promise.resolve(album)} guestPhotos={() => guestPhotos(token, album.id)} /></>;
}
function GuestCollectionRoute() { const { token } = guestCollectionRoute.useParams(); return <GuestCollectionPage token={token} />; }

const rootRoute = createRootRoute();
const albumsRoute = createRoute({ getParentRoute: () => familyRoute, path: '/', component: AlbumsRoute });
const albumsIndexRoute = createRoute({ getParentRoute: () => familyRoute, path: '/albums', component: AlbumsRoute });
const photosRoute = createRoute({ getParentRoute: () => familyRoute, path: '/photos', component: PhotosRoute });
const albumDetailRoute = createRoute({ getParentRoute: () => familyRoute, path: '/albums/$albumID', component: AlbumRoute });
const collectionsRoute = createRoute({ getParentRoute: () => familyRoute, path: '/collections', component: CollectionsRoute });
const collectionDetailRoute = createRoute({ getParentRoute: () => familyRoute, path: '/collections/$collectionID', component: CollectionRoute });
const sharesRoute = createRoute({ getParentRoute: () => familyRoute, path: '/shares', component: SharesRoute });
const guestCollectionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/guest/collect/$token', component: GuestCollectionRoute });
const guestShareRoute = createRoute({ getParentRoute: () => rootRoute, path: '/guest/share/$token', component: GuestShareRoute });
const routeTree = rootRoute.addChildren([
  familyRoute.addChildren([albumsRoute, albumsIndexRoute, photosRoute, albumDetailRoute, collectionsRoute, collectionDetailRoute, sharesRoute]),
  guestCollectionRoute, guestShareRoute,
]);
const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

export function Root() { return <I18nProvider><SiteProvider><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></SiteProvider></I18nProvider>; }
