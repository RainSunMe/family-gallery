import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Image, LayoutGrid, Inbox, Link2, FolderPlus, Settings2, Plus, ImagePlus, ArrowLeft, ArrowDownToLine, Trash2, UploadCloud } from 'lucide-react';
import { Brand } from './ui';
import { DownloadDialog } from './LibraryPages';
import { ShareDialog } from './SharingPages';
import { useHeaderTitleState } from './HeaderTitleContext';
import type { Role, Album } from '../lib/api';
import { listAlbums } from '../lib/api';
import { useT } from '../lib/i18n';

// Only the two doors that actually face family members belong under "Share with
// family": a request link invites them to send photos in, a share link lets them
// look at an album. The queue and the trash are views over this library's own
// state, so they stay with the library. Creating an album is an action, not a
// destination, and the topbar "+" menu already carries it.
const sidebarSections: { label: string; items: { to: string; key: string; icon: typeof Image }[] }[] = [
  {
    label: 'nav.library',
    items: [
      { to: '/photos', key: 'nav.photos', icon: Image },
      { to: '/albums', key: 'nav.albums', icon: LayoutGrid },
      { to: '/uploads', key: 'queue.title', icon: UploadCloud },
      { to: '/trash', key: 'nav.trash', icon: Trash2 },
    ],
  },
  {
    label: 'nav.sharing',
    items: [
      { to: '/collections', key: 'nav.collections', icon: Inbox },
      { to: '/shares', key: 'nav.shares', icon: Link2 },
    ],
  },
];

// The dock carries one extra destination: the upload queue is where a phone user
// actually needs to land while photos are still going up.
const dockNavigation = [
  { to: '/photos', key: 'nav.photos', icon: Image },
  { to: '/albums', key: 'nav.albums', icon: LayoutGrid },
  { to: '/collections', key: 'nav.collections', icon: Inbox },
  { to: '/uploads', key: 'queue.title', icon: UploadCloud },
  { to: '/shares', key: 'nav.shares', icon: Link2 },
];

export function Shell({ children, role, albumCount, queueCount = 0, onUpload, onNewAlbum, onNewCollection, onSettings }: {
  children: React.ReactNode; role: Role; albumCount: number; queueCount?: number; onUpload: () => void; onNewAlbum: () => void; onNewCollection: () => void; onSettings: () => void;
}) {
  const pathname = useRouterState({ select: state => state.location.pathname });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState<Album | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const createRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const queryClient = useQueryClient();
  const { title: headerTitle, back, download, share } = useHeaderTitleState();
  const active = (to: string) => pathname === to || (to === '/albums' && pathname.startsWith('/albums/')) || (to === '/collections' && pathname.startsWith('/collections/'));
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 2);
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { setScrolled(window.scrollY > 2); }, [pathname]);
  useEffect(() => {
    if (!creating) return;
    const close = (event: PointerEvent) => { if (!createRef.current?.contains(event.target as Node)) setCreating(false); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setCreating(false); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', keyboard); };
  }, [creating]);
  const create = (action: () => void) => { setCreating(false); action(); };
  const openShare = async () => {
    if (!share) return;
    const result = await listAlbums();
    const album = result.items.find(item => item.id === share);
    if (album) setSharing(album);
  };
  return <div className="min-h-dvh">
    <aside className="sidebar fixed inset-y-0 left-0 z-20 hidden lg:flex w-[232px] flex-col px-4 py-7 border-r border-line/50">
      <Link to="/albums" className="px-3 mb-9" aria-label={t('nav.albumsHome')}><Brand /></Link>
      {sidebarSections.map((section, sectionIndex) => <Fragment key={section.label}>
        <p className={`text-[11px] text-muted px-3 mb-2 ${sectionIndex > 0 ? 'mt-7' : ''}`}>{t(section.label)}</p>
        <nav className="flex flex-col gap-1" aria-label={t(section.label)}>
          {section.items.map(item => <Link key={item.to} to={item.to} className={`nav-link ${active(item.to) ? 'active' : ''}`}>
            <item.icon className="icon" />
            <span>{t(item.key)}</span>
            {item.to === '/albums' && <small className="ml-auto text-[10px] text-muted">{albumCount}</small>}
            {item.to === '/uploads' && queueCount > 0 && <small className="ml-auto text-[10px] text-accent font-medium">{queueCount}</small>}
          </Link>)}
        </nav>
      </Fragment>)}
      <div className="mt-auto pt-6 border-t border-line/70">
        <button className="w-full flex items-center gap-2.5 p-2 rounded-[10px] text-left hover:bg-soft" onClick={onSettings} aria-label={t('nav.settings')}>
          <span className="w-9 h-9 grid place-items-center rounded-full bg-accent-soft text-accent text-[13px]">{t('role.avatar')}</span>
          <span className="flex-1"><strong className="block text-xs font-medium">{role === 'admin' ? t('role.admin') : t('role.member')}</strong><small className="block text-[10px] text-muted mt-1">{t('role.passphrase')}</small></span>
          <Settings2 className="w-4 h-4 text-secondary" />
        </button>
      </div>
    </aside>
    <main className="lg:ml-[232px] min-h-dvh pb-28 lg:pb-0">
      <div className="topbar-spacer lg:hidden" aria-hidden="true" />
      <div className={`topbar-frame ${scrolled ? 'is-scrolled' : ''}`}>
      <header className={`topbar ${scrolled ? 'is-scrolled' : ''} ${headerTitle ? 'has-title' : ''} fixed top-0 left-0 right-0 z-10 h-16 flex items-center justify-between px-5`}>
        <span className="topbar-glass" aria-hidden="true" />
        <div className={`mobile-title-slot ${back ? 'has-back' : ''}`}>
          <button className={back ? 'mobile-back' : 'mobile-back is-hidden'} onClick={() => navigate({ to: back as never })} aria-label={t('nav.back')} tabIndex={back ? 0 : -1}>
            <ArrowLeft className="icon" />
          </button>          <Link to="/albums" className={headerTitle || back ? 'mobile-brand is-hidden' : 'mobile-brand'} aria-label={t('nav.home')} tabIndex={headerTitle || back ? -1 : 0}><Brand compact /><span className="sr-only">{t('nav.home')}</span></Link>
          <strong className="mobile-heading-title" aria-hidden={!headerTitle}>{headerTitle}</strong>
        </div>
        <div className="flex items-center p-0 topbar-actions">
          {share && <button className="icon-btn plain-action topbar-icon topbar-search" onClick={openShare} aria-label={t('nav.shareAlbum')}><Link2 className="icon" /></button>}
          {download && <button className="icon-btn plain-action topbar-icon topbar-download" onClick={() => setDownloading(true)} aria-label={t('nav.downloadAlbum')}><ArrowDownToLine className="icon" /></button>}
          {queueCount > 0 && <Link to="/uploads" className="icon-btn plain-action topbar-icon" aria-label={t('queue.activeCount', { count: queueCount })} title={t('queue.activeCount', { count: queueCount })}><UploadCloud className="icon" /></Link>}
          <div className="relative topbar-create" ref={createRef}>
            <button className="icon-btn topbar-icon create-button" onClick={() => setCreating(value => !value)} aria-label={t('nav.create')} aria-expanded={creating} aria-haspopup="menu"><Plus className="icon" /></button>
            {creating && <div className="create-menu" role="menu">
              <button role="menuitem" onClick={() => create(onUpload)}><ImagePlus className="icon" /><span><strong>{t('nav.addPhotos')}</strong><small>{t('nav.addPhotosHint')}</small></span></button>
              <button role="menuitem" onClick={() => create(onNewAlbum)}><FolderPlus className="icon" /><span><strong>{t('nav.newAlbum')}</strong><small>{t('nav.newAlbumHint')}</small></span></button>
              <button role="menuitem" onClick={() => create(onNewCollection)}><Inbox className="icon" /><span><strong>{t('nav.newCollection')}</strong><small>{t('nav.newCollectionHint')}</small></span></button>
            </div>}
          </div>
        </div>
      </header>
      </div>
      {children}
      {downloading && download && <DownloadDialog albumID={download} photoIDs={[]} onClose={() => setDownloading(false)} />}
      {sharing && <ShareDialog album={sharing} onClose={() => setSharing(null)} onCreated={() => { void queryClient.invalidateQueries({ queryKey: ['albums'] }); void queryClient.invalidateQueries({ queryKey: ['album', sharing.id] }); }} />}
    </main>
    <nav className={back ? 'mobile-dock is-hidden' : 'mobile-dock'} aria-label={t('nav.mobile')}>
      {dockNavigation.map(item => <Link key={item.to} to={item.to} className={active(item.to) ? 'active' : ''} aria-label={t(item.key)} title={t(item.key)} aria-current={active(item.to) ? 'page' : undefined}>
        <item.icon className="icon" />
        {/* Only the queue can be busy in the background, so only it needs a dot. */}
        {item.to === '/uploads' && queueCount > 0 && <span className="mobile-dock-dot" aria-hidden="true" />}
      </Link>)}
    </nav>
    <style>{`
      .nav-link{display:flex;align-items:center;gap:11px;min-height:44px;padding:10px 12px;border-radius:9px;font-size:13px;color:var(--color-secondary);text-align:left;position:relative}
      .nav-link:hover{background:var(--color-soft);color:var(--color-ink)}
      .nav-link.active{background:var(--color-accent-soft);color:var(--color-accent);font-weight:550}
      .nav-link.active:before{content:'';position:absolute;left:-16px;width:3px;height:15px;background:var(--color-accent);border-radius:0 3px 3px 0}
      .topbar-icon{color:var(--color-ink)!important;background:transparent!important;opacity:1}
      .topbar-icon:hover,.topbar-icon:active{opacity:.6;transform:none}
      .topbar-actions{display:flex;align-items:center;gap:var(--icon-btn-gap);margin-left:auto;margin-right:calc(-1 * var(--icon-btn-shift))}
      .sidebar{background:var(--color-sidebar)}
      .topbar{background:transparent;transition:background .24s ease,border-color .24s ease}
      .topbar-spacer{flex-shrink:0}
      /* One frosted panel, no stacked gradients: a flat tint, a real backdrop
         blur and a hairline border read as glass; layered gradients read as fog. */
      .topbar-glass{position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:0;background:rgba(255,255,255,.72);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border-bottom:1px solid rgba(17,24,39,.08);transition:opacity .26s ease}
      .topbar.is-scrolled .topbar-glass{opacity:1}
      .dark .topbar-glass{background:rgba(18,19,22,.74);border-bottom-color:rgba(255,255,255,.08)}
      .mobile-title-slot{position:relative;display:flex;align-items:center;min-width:0;flex:1;height:100%;overflow:visible;mask-image:linear-gradient(90deg,#000 92%,transparent)}
      .mobile-brand{display:inline-flex;align-items:center;transition:transform .34s cubic-bezier(.22,.78,.2,1),opacity .24s ease}
      .mobile-brand.is-hidden{transform:translateY(-120%);opacity:0;pointer-events:none;position:absolute;left:0;top:50%;margin-top:-16px}
      .mobile-back{position:relative;display:flex;align-items:center;justify-content:center;width:var(--icon-btn-size);height:var(--icon-btn-size);margin-left:calc(-1 * var(--icon-btn-shift));padding:0;border:0;border-radius:11px;color:var(--color-ink)!important;background:transparent;flex-shrink:0;-webkit-tap-highlight-color:transparent}
      .mobile-back .icon{width:var(--icon-btn-ink);height:var(--icon-btn-ink);stroke-width:var(--icon-btn-stroke)}
      .mobile-back:active{background:transparent;transform:none;color:var(--color-ink);opacity:.7}
      .mobile-back.is-hidden{display:none}
      .mobile-title-slot.has-back{gap:8px}
      .mobile-title-slot.has-back .mobile-heading-title{left:40px}
      .mobile-heading-title{position:absolute;left:0;top:50%;transform:translateY(calc(-50% + 130%));opacity:0;font-size:15px;font-weight:550;color:var(--color-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:transform .34s cubic-bezier(.22,.78,.2,1),opacity .22s ease .04s;pointer-events:none}
      .topbar.has-title .mobile-heading-title{transform:translateY(-50%);opacity:1}
      .create-menu{position:absolute;right:var(--icon-btn-shift);top:calc(100% + 10px);z-index:45;width:236px;padding:7px;border:1px solid #ffffffb3;border-radius:16px;background:color-mix(in srgb,var(--color-surface) 78%,transparent);box-shadow:0 8px 24px #1b29300f,0 2px 8px #1b293006;backdrop-filter:blur(32px) saturate(190%);-webkit-backdrop-filter:blur(32px) saturate(190%);animation:context-in .16s ease}
      .dark .create-menu{border-color:#ffffff1f;background:#22262cd9}
      .create-menu button{display:flex;align-items:center;gap:12px;width:100%;padding:11px 12px;border-radius:10px;text-align:left;color:var(--color-secondary);transition:background .15s}
      .create-menu button:hover{background:color-mix(in srgb,var(--color-ink) 7%,transparent);color:var(--color-ink)}
      .create-menu strong{display:block;font-size:var(--text-secondary);font-weight:500;color:var(--color-ink)}
      .create-menu small{display:block;font-size:var(--text-caption);color:var(--color-muted);margin-top:3px}
      @media(min-width:1024px){
        /* The bar used to be absolute inside a zero-height frame, so it scrolled
           away with the page. It is now pinned to the viewport across the whole
           area right of the sidebar: the frosted panel spans that full width via
           the frame's own layer, while the inner row stays aligned with the
           centred content column. */
        .topbar-frame{display:block;position:fixed;top:0;left:232px;right:0;z-index:20;height:calc(64px + env(safe-area-inset-top));padding-top:env(safe-area-inset-top);max-width:none;margin:0}
        /* Nothing is painted until the content slides under the bar: at rest the
           header is invisible, exactly like on mobile. */
        .topbar-frame:before{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:0;background:rgba(255,255,255,.72);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border-bottom:1px solid rgba(17,24,39,.08);transition:opacity .26s ease}
        .topbar-frame.is-scrolled:before{opacity:1}
        .dark .topbar-frame:before{background:rgba(18,19,22,.74);border-bottom-color:rgba(255,255,255,.08)}
        /* The mobile glass layer would otherwise paint a second panel. */
        .topbar .topbar-glass{display:none}
        .topbar{position:relative;inset:auto;left:auto;right:auto;top:auto;width:100%;max-width:1580px;margin:0 auto;height:100%;padding:0 var(--page-x);display:flex;align-items:center;justify-content:space-between;background:transparent}
        /* The brand lives in the sidebar on desktop, so the slot only carries the
           back button and the title that slides in once the heading scrolls under. */
        .topbar .mobile-title-slot{display:flex;flex:1;min-width:0;position:relative;overflow:visible;mask-image:none}
        .topbar .mobile-brand{display:none}
        .topbar .mobile-title-slot.has-back{flex:0 0 auto}
        .topbar .mobile-title-slot.has-back .mobile-heading-title{left:44px}
        .topbar .mobile-heading-title{display:block}
        /* Same action cluster on the right at every breakpoint: the leading edge
           stays free for content, so nothing can overlap the page heading. */
        .topbar-actions{margin-left:auto}
      }
      @media(max-width:1023px){
        .topbar-spacer{height:calc(56px + env(safe-area-inset-top))}
        /* Five destinations in a pill narrow enough not to crowd a 360px screen:
           38px hit targets, 2px gaps, 5px padding. Same single-layer glass recipe
           as the header — one tint, one blur, one hairline. */
        .mobile-dock{display:flex;position:fixed;left:50%;right:auto;bottom:calc(12px + env(safe-area-inset-bottom));transform:translateX(-50%);width:auto;max-width:calc(100vw - 32px);height:54px;padding:5px 7px;gap:2px;align-items:center;justify-content:center;border-radius:999px;z-index:30;isolation:isolate;background:rgba(255,255,255,.68);border:1px solid rgba(255,255,255,.6);box-shadow:0 12px 30px -10px rgba(16,24,40,.26),0 2px 8px -2px rgba(16,24,40,.1),inset 0 1px 0 rgba(255,255,255,.75);backdrop-filter:blur(24px) saturate(190%);-webkit-backdrop-filter:blur(24px) saturate(190%);transition:transform .26s cubic-bezier(.22,.78,.2,1),opacity .2s ease}
        .mobile-dock.is-hidden{display:none}
        .dark .mobile-dock{background:rgba(24,25,28,.7);border-color:rgba(255,255,255,.1);box-shadow:0 12px 30px -10px rgba(0,0,0,.6),0 2px 8px -2px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08)}
        .mobile-dock a{position:relative;display:grid;place-items:center;flex:0 0 40px;width:40px;height:42px;border-radius:999px;color:#3f4b4d;transition:background .2s,color .2s,transform .2s}
        .dark .mobile-dock a{color:#b4c3c6}
        .mobile-dock a .icon{width:20px;height:20px;stroke-width:1.7}
        .mobile-dock a.active{color:var(--color-ink);background:rgba(17,24,39,.09)}
        .dark .mobile-dock a.active{background:rgba(255,255,255,.14)}
        .mobile-dock a:active{transform:scale(.92)}
        .mobile-dock-dot{position:absolute;top:7px;right:8px;width:6px;height:6px;border-radius:999px;background:var(--color-accent)}
        .dark .mobile-dock-dot{background:#fafafa}
        .topbar{padding-top:env(safe-area-inset-top);height:calc(56px + env(safe-area-inset-top));padding-left:var(--page-x);padding-right:calc(var(--page-x) + env(safe-area-inset-right))}
      }
      @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
        .topbar.is-scrolled .topbar-glass{opacity:1;background:var(--color-surface)}
        .topbar-frame:before{background:var(--color-surface)}
        .mobile-dock{background:var(--color-surface)}
      }
    `}</style>
  </div>;
}
