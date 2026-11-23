import { useState } from 'react';
import type { FormEvent } from 'react';
import { ImagePlus, LoaderCircle, UploadCloud } from 'lucide-react';
import { Dialog, Note } from './ui';
import { uploadPhoto, uploadGuestPhoto } from '../lib/upload';
import type { Album } from '../lib/api';
import { useT } from '../lib/i18n';

export function UploadDialog({ albums, initialAlbum, onClose, onComplete }: { albums: Album[]; initialAlbum: string; onClose: () => void; onComplete: () => void }) {
  const t = useT();
  const [albumID, setAlbumID] = useState(initialAlbum || albums[0]?.id || '');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const running = progress !== null && progress.current < progress.total;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!albumID || !files.length || running) return;
    setError(''); setProgress({ current: 0, total: files.length, label: t('uploadDialog.preparing') });
    const failed: string[] = [];
    for (let index = 0; index < files.length; index++) {
      setProgress({ current: index, total: files.length, label: t('uploadDialog.uploadingFile', { name: files[index].name }) });
      try { await uploadPhoto(files[index], albumID); }
      catch (reason) { failed.push(t('uploadDialog.failedItem', { name: files[index].name, message: reason instanceof Error ? reason.message : t('uploadDialog.failed') })); }
    }
    setProgress({ current: files.length, total: files.length, label: failed.length ? t('uploadDialog.summaryMixed', { ok: files.length - failed.length, failed: failed.length }) : t('uploadDialog.summaryOk', { count: files.length }) });
    if (failed.length) { setError(failed.join('\n')); onComplete(); }
    else { onComplete(); onClose(); }
  }
  return <Dialog title={t('uploadDialog.title')} description={t('uploadDialog.description')} onClose={() => { if (!running) onClose(); }}>
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="upload-album">{t('uploadDialog.album')}</label>
      <select className="field" id="upload-album" value={albumID} onChange={event => setAlbumID(event.target.value)} disabled={running}>{albums.map(album => <option key={album.id} value={album.id}>{album.name}</option>)}</select>
      <label className={`mt-5 min-h-[190px] flex flex-col items-center justify-center text-center border border-dashed rounded-xl p-6 cursor-pointer transition-colors ${dragging ? 'border-accent bg-accent-soft' : 'border-[#b7cacb] bg-canvas'}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); setFiles(Array.from(event.dataTransfer.files)); }}>
        <span className="w-12 h-12 grid place-items-center rounded-[13px] bg-accent-soft text-accent mb-4"><ImagePlus className="w-6 h-6" /></span>
        <strong className="text-sm font-medium">{t('uploadDialog.dropTitle')}</strong>
        <span className="text-xs text-muted mt-2 leading-7 whitespace-pre-line">{t('uploadDialog.dropHint')}</span>
        <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={event => setFiles(Array.from(event.target.files || []))} disabled={running} />
      </label>
      {files.length > 0 && <div className="mt-4 max-h-[180px] overflow-auto space-y-2">{files.map((file, index) => <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas text-xs" key={`${file.name}-${index}`}><ImagePlus className="w-4 h-4 text-accent" /><span className="truncate flex-1">{file.name}</span><span className="text-muted text-[10px]">{Math.max(.1, file.size / 1024 / 1024).toFixed(1)} MB</span></div>)}</div>}
      {progress && <div className="mt-5"><div className="flex justify-between text-xs text-secondary mb-2"><span>{progress.label}</span><span>{Math.round(progress.current / progress.total * 100)}%</span></div><div className="h-1.5 bg-soft rounded-full overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${progress.current / progress.total * 100}%` }} /></div></div>}
      {error && <pre className="mt-4 text-xs leading-6 text-[#a25142] whitespace-pre-wrap">{error}</pre>}
      <Note>{t('uploadDialog.note')}</Note>
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose} disabled={running}>{t('uploadDialog.close')}</button><button className="btn btn-primary" disabled={!files.length || !albumID || running}>{running ? <LoaderCircle className="icon animate-spin" /> : <UploadCloud className="icon" />}{running ? t('uploadDialog.busy') : t('uploadDialog.submit', { count: files.length })}</button></div>
    </form>
  </Dialog>;
}

export function GuestUploadButton({ files, message, onComplete }: { files: File[]; message: string; onComplete: (success: number, errors: string[]) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  return <div>
    {busy && <p className="text-xs text-secondary text-center mb-3" role="status">{progress}</p>}
    <button className="btn btn-primary w-full min-h-12" disabled={!files.length || busy} onClick={async () => {
      setBusy(true); const errors: string[] = []; let success = 0;
      for (let index = 0; index < files.length; index++) {
        setProgress(t('uploadDialog.progress', { index: index + 1, total: files.length, name: files[index].name }));
        try { await uploadGuestPhoto(files[index], message); success++; }
        catch (reason) { errors.push(reason instanceof Error ? reason.message : t('uploadDialog.failed')); }
      }
      setBusy(false); onComplete(success, errors);
    }}>{busy ? <LoaderCircle className="icon animate-spin" /> : <UploadCloud className="icon" />}{busy ? t('uploadDialog.busy') : t('uploadDialog.submit', { count: files.length })}</button>
  </div>;
}
