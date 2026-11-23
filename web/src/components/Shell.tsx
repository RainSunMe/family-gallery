import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Image, LayoutGrid, Inbox, Link2, FolderPlus, Settings2, Plus, ImagePlus, ArrowLeft, ArrowDownToLine, Trash2 } from 'lucide-react';
import { Brand } from './ui';
import { DownloadDialog } from './LibraryPages';
import { ShareDialog } from './SharingPages';
import { useHeaderTitleState } from './HeaderTitleContext';
import type { Role, Album } from '../lib/api';
import { listAlbums } from '../lib/api';
import { useT } from '../lib/i18n';

const navigation = [
  { to: '/photos', key: 'nav.photos', icon: Image },
  { to: '/albums', key: 'nav.albums', icon: LayoutGrid },
  { to: '/collections', key: 'nav.collections', icon: Inbox },
  { to: '/shares', key: 'nav.shares', icon: Link2 },
];

export function Shell({ children, role, albumCount, onUpload, onNewAlbum, onNewCollection, onSettings }: {
  children: React.ReactNode; role: Role; albumCount: number; onUpload: () => void; onNewAlbum: () => void; onNewCollection: () => void; onSettings: () => void;
}) {
  const pathname = useRouterState({ select: state => state.location.pathname });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState<Album | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const createRef = useRef<HTMLDivElement>(null);
  const t = useT();
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
      <p className="text-[11px] text-muted px-3 mb-2">{t('nav.library')}</p>
      <nav className="flex flex-col gap-1 mb-6" aria-label={t('nav.desktop')}>
        {navigation.slice(0,3).map(item => <Link key={item.to} to={item.to} className={`nav-link ${active(item.to) ? 'active' : ''}`}><item.icon className="icon" /><span>{t(item.key)}</span>{item.to === '/albums' && <small className="ml-auto text-[10px] text-muted">{albumCount}</small>}</Link>)}
      </nav>
      <p className="text-[11px] text-muted px-3 mb-2">{t('nav.sharing')}</p>
      <nav className="flex flex-col gap-1" aria-label={t('nav.sharingCreate')}>
        <Link to="/shares" className={`nav-link ${active('/shares') ? 'active' : ''}`}><Link2 className="icon" /><span>{t('nav.shares')}</span></Link>
        <button className="nav-link" onClick={onNewAlbum}><FolderPlus className="icon" /><span>{t('nav.newAlbum')}</span></button>
        <Link to="/trash" className={`nav-link ${active('/trash') ? 'active' : ''}`}><Trash2 className="icon" /><span>{t('nav.trash')}</span></Link>
      </nav>
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
      <div className="topbar-frame">
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
      {sharing && <ShareDialog album={sharing} onClose={() => setSharing(null)} onCreated={() => setSharing(null)} />}
    </main>
    <nav className={back ? 'mobile-dock is-hidden' : 'mobile-dock'} aria-label={t('nav.mobile')}>
      <span className="mobile-dock-pill" aria-hidden="true" />
      {navigation.map(item => <Link key={item.to} to={item.to} className={active(item.to) ? 'active' : ''} aria-label={t(item.key)} title={t(item.key)} aria-current={active(item.to) ? 'page' : undefined}><item.icon className="icon" /></Link>)}
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
      .topbar-glass{position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:0;background:linear-gradient(180deg,#ffffffc9,#ffffffdb);backdrop-filter:blur(28px) saturate(190%);-webkit-backdrop-filter:blur(28px) saturate(190%);border-bottom:1px solid #ffffff7a;transition:opacity .26s ease}
      .topbar-glass:before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,#ffffff3d,transparent 55%);pointer-events:none}
      .topbar.is-scrolled .topbar-glass{opacity:1}
      .dark .topbar-glass{background:linear-gradient(180deg,#252a31e0,#22262cf2);border-bottom-color:#ffffff17}
      .dark .topbar-glass:before{background:linear-gradient(180deg,#ffffff0f,transparent 60%)}
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
        .topbar-frame{display:block;height:0;position:relative;z-index:20;max-width:1580px;margin:0 auto;padding:0 var(--page-x)}
        .topbar{position:absolute;left:var(--page-x);right:var(--page-x);top:var(--topbar-top);width:auto;min-width:0;height:48px;padding:0}
        /* Secondary pages keep the same back affordance on desktop; only the
           mobile brand and the scrolling heading label are desktop-hidden. */
        .topbar .mobile-title-slot{display:none}
        .topbar .mobile-title-slot.has-back{display:flex;flex:0 0 auto;overflow:visible;mask-image:none}
        .topbar .mobile-title-slot.has-back .mobile-brand,
        .topbar .mobile-title-slot.has-back .mobile-heading-title{display:none}
        /* Same action cluster on the right at every breakpoint: the leading edge
           stays free for content, so nothing can overlap the page heading. */
        .topbar-actions{margin-left:auto}
      }
      @media(max-width:1023px){
        .topbar-spacer{height:calc(56px + env(safe-area-inset-top))}
        .mobile-dock{display:flex;position:fixed;left:50%;right:auto;bottom:calc(13px + env(safe-area-inset-bottom));transform:translateX(-50%);width:264px;max-width:calc(100vw - 48px);height:60px;padding:6px 9px;gap:7px;align-items:center;justify-content:space-between;border-radius:100px;z-index:30;isolation:isolate;background:transparent;border:1px solid transparent;backdrop-filter:blur(30px) saturate(200%);-webkit-backdrop-filter:blur(30px) saturate(200%);transition:transform .26s cubic-bezier(.22,.78,.2,1),opacity .2s ease}
        .mobile-dock.is-hidden{display:none}
        .mobile-dock-pill{position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,#ffffffa8,#ffffff73);border:1px solid #ffffffc2;box-shadow:0 8px 30px #18243024,inset 0 1px 0 #ffffffd9,inset 0 -1px 0 #ffffff45}
        .mobile-dock-pill:after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(125deg,#ffffff5c,transparent 45%)}
        .dark .mobile-dock-pill{background:linear-gradient(180deg,#2b3038b3,#24282ea6);border-color:#ffffff26;box-shadow:0 8px 30px #0005,inset 0 1px 0 #ffffff1a}
        .mobile-dock a{position:relative;display:grid;place-items:center;flex:0 0 48px;width:48px;height:46px;border-radius:50%;color:#40605f;transition:background .2s,color .2s,transform .2s}
        .dark .mobile-dock a{color:#b4c3c6}
        .mobile-dock a .icon{width:23px;height:23px;stroke-width:1.7}
        .mobile-dock a.active{color:var(--color-accent);background:color-mix(in srgb,var(--color-accent) 14%,transparent)}
        .mobile-dock a:active{background:color-mix(in srgb,var(--color-accent) 22%,transparent);transform:scale(.92)}
        .topbar{padding-top:env(safe-area-inset-top);height:calc(56px + env(safe-area-inset-top));padding-left:var(--page-x);padding-right:calc(var(--page-x) + env(safe-area-inset-right))}
      }
      @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.topbar.is-scrolled .topbar-glass{opacity:1;background:var(--color-surface)}.mobile-dock-pill{background:var(--color-surface)}}
    `}</style>
  </div>;
}
