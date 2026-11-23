import { useEffect, useState } from 'react';
import { ArrowUpFromLine, Check, Clock3, ImagePlus, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Brand, Note } from './ui';
import { GuestUploadButton } from './UploadDialog';
import { UPLOAD_ACCEPT } from '../lib/decode';
import { guestCollection, guestSession, guestSubmissions } from '../lib/api';
import { useI18n } from '../lib/i18n';

export function GuestCollectionPage({ token }: { token: string }) {
  const { t, locale, setLocale } = useI18n();
  const [sessionReady, setSessionReady] = useState(false);
  const [needsName, setNeedsName] = useState(false);
  const [name, setName] = useState('');
  const [info, setInfo] = useState<{ name: string; description: string; expires_at: string; batch_limit: number; allow_message: boolean } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submissions, setSubmissions] = useState<{ id: string; name: string; url: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  async function load() {
    try { const data = await guestCollection(); setInfo(data); setSessionReady(true); setNeedsName(false); setSubmissions((await guestSubmissions()).items); }
    catch { setNeedsName(true); }
  }
  useEffect(() => { load().catch(() => setNeedsName(true)); }, [token]);
  async function join() {
    if (!name.trim()) return; setBusy(true);
    try { await guestSession(token, name.trim()); await load(); }
    catch (reason) { setErrors([reason instanceof Error ? reason.message : t('guest.collectionUnavailable')]); }
    finally { setBusy(false); }
  }
  return <div className="min-h-dvh bg-soft text-ink">
    <header className="h-[76px] max-w-[960px] mx-auto px-6 flex items-center justify-between"><Brand /><span className="inline-flex items-center gap-1.5 text-xs text-muted"><ShieldCheck className="w-4 h-4" />{t('guest.privateCollection')}</span><button className="text-[11px] text-muted hover:text-ink ml-4" onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}>{locale === 'zh' ? 'English' : '中文'}</button></header>
    <main className="guest-main">
      <div className="guest-hero"><div className="absolute inset-0 bg-ink" /><div className="absolute inset-0 bg-gradient-to-t from-[#000000cc] to-transparent" /><span className="absolute left-5 top-5 inline-flex items-center gap-1.5 text-[11px] text-white bg-white/10 border border-white/20 px-2.5 py-1.5 rounded-md backdrop-blur-md"><ImagePlus className="w-3.5 h-3.5" />{t('guest.invitedByFamily')}</span><div className="absolute bottom-6 left-6 text-white"><p className="text-[9px] tracking-[2px] text-white/70 mb-2">TOGETHER, WE REMEMBER</p><h1 className="text-[31px] font-medium tracking-tight leading-normal">{info?.name || t('guest.defaultTitle')}</h1><p className="text-[13px] text-white/80 mt-1">{info?.description || t('guest.defaultDescription')}</p></div></div>
      <div className="p-6 sm:p-7">
        <div className="flex items-center gap-3 pb-5 mb-5 border-b border-line"><span className="w-9 h-9 grid place-items-center rounded-full bg-soft text-ink text-xs">{t('guest.avatar')}</span><div className="flex-1"><strong className="block text-[13px] font-medium">{t('guest.familyInvite')}</strong><small className="flex items-center gap-1 text-[11px] text-muted mt-1"><Clock3 className="w-3 h-3" />{info?.expires_at ? t('collection.dueBy', { date: new Date(info.expires_at).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US') }) : t('collection.noExpiry')} · {t('guest.rawUpload')}</small></div><span className="text-[10px] px-2 py-1 rounded bg-soft text-secondary">{t('guest.noSignup')}</span></div>
        {needsName ? <div className="py-3"><h2 className="text-xl font-medium mb-2">{t('guest.nameTitle')}</h2><p className="text-xs text-muted mb-5 leading-6">{t('guest.nameHint')}</p><label className="field-label" htmlFor="guest-name">{t('guest.nameLabel')}</label><input className="field" id="guest-name" value={name} onChange={event => setName(event.target.value)} maxLength={24} placeholder={t('guest.namePlaceholder')} autoComplete="nickname" onKeyDown={event => { if (event.key === 'Enter') join(); }} /><button className="btn btn-primary w-full mt-5" onClick={join} disabled={!name.trim() || busy}>{busy ? <LoaderCircle className="icon animate-spin" /> : <ArrowUpFromLine className="icon" />} {t('guest.continueUpload')}</button>{errors.length > 0 && <p className="text-xs text-[#a25142] mt-4 leading-6">{errors.join('\n')}</p>}<Note>{t('guest.uploadNote')}</Note></div> : sessionReady && info ? success ? <div className="text-center py-7"><span className="w-14 h-14 grid place-items-center rounded-full bg-soft text-ink mx-auto mb-5"><Check className="w-7 h-7" /></span><h2 className="text-xl font-medium">{t('guest.thanks')}</h2><p className="text-xs text-muted leading-6 mt-3">{t('guest.submitted', { count: success })}</p>{errors.length > 0 && <p className="text-xs text-[#a25142] mt-4">{errors.join('\n')}</p>}<button className="btn btn-primary mt-6" onClick={() => { setSuccess(0); setFiles([]); setErrors([]); load(); }}>{t('guest.uploadMore')}</button></div> : <><label className={`guest-drop ${dragging ? 'border-ink bg-soft' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); setFiles(Array.from(event.dataTransfer.files).slice(0, info.batch_limit)); }}><span className="w-12 h-12 grid place-items-center rounded-[13px] bg-soft text-ink mb-4"><ImagePlus className="w-6 h-6" /></span><strong className="text-sm font-medium">{t('guest.chooseDay')}</strong><span className="text-[11px] text-[#647c75] leading-6 mt-2">{t('guest.chooseHint', { count: info.batch_limit })}</span><span className="btn btn-secondary mt-4">{t('guest.choosePhotos')}</span><input className="sr-only" type="file" accept={UPLOAD_ACCEPT} multiple onChange={event => setFiles(Array.from(event.target.files || []).slice(0, info.batch_limit))} /></label>{files.length > 0 && <div className="mt-4 max-h-[180px] overflow-auto space-y-2">{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#f5f8f7] text-xs"><ImagePlus className="w-4 h-4 text-[#558979]" /><span className="truncate flex-1">{file.name}</span><span className="text-[#647c75] text-[10px]">{(file.size / 1024 / 1024).toFixed(1)} MB</span></div>)}</div>}{info.allow_message && <><label className="field-label" htmlFor="guest-message">{t('guest.messageLabel')} <span>{t('common.optional')}</span></label><textarea className="field bg-[#f5f8f7] min-h-[78px]" id="guest-message" value={message} onChange={event => setMessage(event.target.value)} maxLength={200} placeholder={t('guest.messagePlaceholder')} /></>}<div className="flex items-start gap-2 mt-5 text-[#647b72]"><LockKeyhole className="w-3.5 h-3.5 mt-1" /><p className="text-[11px] leading-6">{t('guest.privacy')}</p></div><div className="mt-5"><GuestUploadButton files={files} message={message} onComplete={(count, uploadErrors) => { setSuccess(count); setErrors(uploadErrors); }} /></div>{submissions.length > 0 && <div className="mt-6 pt-5 border-t border-[#e7eeeb]"><p className="text-xs text-[#667e75] mb-3">{t('guest.submittedCount', { count: submissions.length })}</p><div className="flex gap-2 overflow-auto">{submissions.map(item => <img key={item.id} src={item.url} alt={item.name} className="w-14 h-14 rounded-md object-cover" />)}</div></div>}</> : <div className="py-12 text-center"><LoaderCircle className="w-6 h-6 animate-spin mx-auto text-[#337d71]" /><p className="text-xs text-[#667e75] mt-3">{t('guest.verifying')}</p></div>}
        <p className="text-center text-muted text-[11px] leading-6 mt-6">{t('guest.footer')}</p>
      </div>
    </main>
    <style>{`.guest-main{width:520px;max-width:calc(100vw - 40px);margin:16px auto 70px;background:var(--color-surface);border:1px solid var(--color-line);border-radius:22px;overflow:hidden;box-shadow:0 12px 40px #0a0a0a0a}.guest-hero{height:220px;position:relative;overflow:hidden}.guest-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border:1px dashed var(--color-line);background:var(--color-soft);border-radius:12px;min-height:210px;padding:22px;cursor:pointer}.guest-main .field{background:var(--color-surface);border-color:var(--color-line);color:var(--color-ink)}@media(max-width:700px){.guest-main{width:100%;max-width:none;margin:0;border-radius:22px 22px 0 0;border-left:0;border-right:0;min-height:calc(100dvh - 68px)}.guest-hero{height:254px}}`}</style>
  </div>;
}
