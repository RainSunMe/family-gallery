import { useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, ImagePlus, LoaderCircle, UploadCloud } from 'lucide-react';
import { Dialog, Note } from './ui';
import { checkDuplicates, uploadPhoto, uploadGuestPhoto } from '../lib/upload';
import { hashFiles } from '../lib/hash';
import type { Album, ExistingPhoto } from '../lib/api';
import { ApiError } from '../lib/api';
import { useT } from '../lib/i18n';

type Duplicate = { file: File; existing: ExistingPhoto };
// The result of hashing plus the server's duplicate check, kept so the review
// step can upload without hashing a second time.
type Analysis = { hashes: Map<File, string>; candidates: File[]; duplicates: Duplicate[]; merged: number; legacy: number };

export function UploadDialog({ albums, initialAlbum, onClose, onComplete }: { albums: Album[]; initialAlbum: string; onClose: () => void; onComplete: () => void }) {
  const t = useT();
  const [albumID, setAlbumID] = useState(initialAlbum || albums[0]?.id || '');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [hashing, setHashing] = useState<{ done: number; total: number } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const running = progress !== null && progress.current < progress.total;
  const reviewing = analysis !== null && analysis.duplicates.length > 0;
  const skippedByDefault = analysis && !includeDuplicates ? analysis.duplicates.length : 0;
  const pendingCount = analysis ? analysis.candidates.length - skippedByDefault : files.length;

  function reset() {
    setAnalysis(null); setIncludeDuplicates(false); setError(''); setProgress(null); setHashing(null);
  }

  function pickFiles(next: File[]) {
    setFiles(next);
    reset();
  }

  async function upload(hashes: Map<File, string>, candidates: File[], duplicates: Duplicate[], withDuplicates: boolean) {
    const targets = candidates.filter(file => withDuplicates || !duplicates.some(item => item.file === file));
    if (!targets.length) return;
    setError(''); setProgress({ current: 0, total: targets.length, label: t('uploadDialog.preparing') });
    const failed: string[] = [];
    let skipped = 0;
    for (let index = 0; index < targets.length; index++) {
      const file = targets[index];
      setProgress({ current: index, total: targets.length, label: t('uploadDialog.uploadingFile', { name: file.name }) });
      try {
        await uploadPhoto(file, albumID, { contentHash: hashes.get(file), allowDuplicate: withDuplicates });
      } catch (reason) {
        // A race can still surface a duplicate: another upload of the same bytes
        // landed between the check and this request.
        if (reason instanceof ApiError && reason.code === 'DUPLICATE_PHOTO') skipped += 1;
        else failed.push(t('uploadDialog.failedItem', { name: file.name, message: reason instanceof Error ? reason.message : t('uploadDialog.failed') }));
      }
    }
    const completed = targets.length - failed.length - skipped;
    const summary = failed.length
      ? t('uploadDialog.summaryMixed', { ok: completed, failed: failed.length })
      : t('uploadDialog.summaryOk', { count: completed });
    setProgress({
      current: targets.length, total: targets.length,
      label: skipped ? `${summary} · ${t('upload.skippedSummary', { count: skipped })}` : summary,
    });
    if (failed.length) { setError(failed.join('\n')); onComplete(); }
    else { onComplete(); onClose(); }
  }

  // Phase one: hash locally, merge identical files, then ask the server what the
  // album already contains. Uploading only starts after this, so nothing is
  // transferred just to be rejected.
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!albumID || !files.length || running || hashing) return;
    if (analysis) { await upload(analysis.hashes, analysis.candidates, analysis.duplicates, includeDuplicates); return; }
    setError(''); setProgress(null);
    setHashing({ done: 0, total: files.length });
    let hashes: Map<File, string>;
    try {
      hashes = await hashFiles(files, (done, total) => setHashing({ done, total }));
    } catch {
      setHashing(null); setError(t('upload.hashFailed'));
      return;
    }
    // Identical files inside one batch are merged before anything is sent.
    const byHash = new Map<string, File>();
    let merged = 0;
    for (const file of files) {
      const hash = hashes.get(file);
      if (!hash) continue;
      if (byHash.has(hash)) { merged += 1; continue; }
      byHash.set(hash, file);
    }
    const candidates = [...byHash.values()];
    let result;
    try {
      result = await checkDuplicates(albumID, [...byHash.keys()]);
    } catch (reason) {
      setHashing(null);
      setError(reason instanceof Error ? reason.message : t('upload.checkFailed'));
      return;
    }
    setHashing(null);
    const duplicates = candidates
      .map(file => ({ file, existing: result.duplicates[hashes.get(file)!] }))
      .filter((item): item is Duplicate => !!item.existing);
    setAnalysis({ hashes, candidates, duplicates, merged, legacy: result.legacy_photos });
    // Nothing to review: go straight to uploading.
    if (!duplicates.length) await upload(hashes, candidates, duplicates, false);
  }

  const busy = running || hashing !== null;
  return <Dialog title={t('uploadDialog.title')} description={t('uploadDialog.description')} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="upload-album">{t('uploadDialog.album')}</label>
      <select className="field" id="upload-album" value={albumID} onChange={event => { setAlbumID(event.target.value); reset(); }} disabled={busy}>{albums.map(album => <option key={album.id} value={album.id}>{album.name}</option>)}</select>
      <label className={`mt-5 min-h-[190px] flex flex-col items-center justify-center text-center border border-dashed rounded-xl p-6 cursor-pointer transition-colors ${dragging ? 'border-accent bg-accent-soft' : 'border-[#b7cacb] bg-canvas'}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) pickFiles(Array.from(event.dataTransfer.files)); }}>
        <span className="w-12 h-12 grid place-items-center rounded-[13px] bg-accent-soft text-accent mb-4"><ImagePlus className="w-6 h-6" /></span>
        <strong className="text-sm font-medium">{t('uploadDialog.dropTitle')}</strong>
        <span className="text-xs text-muted mt-2 leading-7 whitespace-pre-line">{t('uploadDialog.dropHint')}</span>
        <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={event => pickFiles(Array.from(event.target.files || []))} disabled={busy} />
      </label>

      {files.length > 0 && <div className="mt-4 max-h-[180px] overflow-auto space-y-2">{files.map((file, index) => <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas text-xs" key={`${file.name}-${index}`}><ImagePlus className="w-4 h-4 text-accent" /><span className="truncate flex-1">{file.name}</span><span className="text-muted text-[10px]">{Math.max(.1, file.size / 1024 / 1024).toFixed(1)} MB</span></div>)}</div>}

      {hashing && <div className="mt-5"><div className="flex justify-between text-xs text-secondary mb-2"><span>{t('upload.checking', { done: hashing.done, total: hashing.total })}</span><span>{hashing.total ? Math.round(hashing.done / hashing.total * 100) : 0}%</span></div><div className="h-1.5 bg-soft rounded-full overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${hashing.total ? hashing.done / hashing.total * 100 : 0}%` }} /></div></div>}

      {reviewing && analysis && <div className="mt-5 rounded-xl border border-line bg-canvas p-4">
        <p className="flex items-center gap-2 text-xs font-medium text-[#a2663d]"><AlertTriangle className="w-4 h-4 shrink-0" />{t('upload.duplicatesTitle', { count: analysis.duplicates.length })}</p>
        <div className="mt-3 max-h-[180px] overflow-auto space-y-2">{analysis.duplicates.map(({ file, existing }) => <div className="flex items-center gap-3" key={file.name}>
          {existing.thumb_url ? <img src={existing.thumb_url} alt="" className="w-10 h-10 rounded-md object-cover shrink-0" /> : <span className="w-10 h-10 rounded-md bg-soft shrink-0" />}
          <span className="min-w-0 flex-1"><span className="block truncate text-xs">{existing.name || file.name}</span><span className="block text-[10px] text-muted mt-0.5 truncate">{[existing.contributor, file.name].filter(Boolean).join(' · ')}</span></span>
        </div>)}</div>
        <p className="mt-3 text-[10px] text-muted leading-5">{t('upload.duplicatesNote')}</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-secondary"><input type="checkbox" className="accent-ink" checked={includeDuplicates} onChange={event => setIncludeDuplicates(event.target.checked)} />{t('upload.includeDuplicates')}</label>
      </div>}

      {analysis && analysis.merged > 0 && <p className="mt-3 text-[11px] text-muted">{t('upload.batchMerged', { count: analysis.merged })}</p>}
      {analysis && analysis.legacy > 0 && <p className="mt-2 text-[11px] text-muted leading-5">{t('upload.legacyNote', { count: analysis.legacy })}</p>}
      {reviewing && pendingCount === 0 && <p className="mt-3 text-[11px] text-muted">{t('upload.allDuplicates')}</p>}

      {progress && <div className="mt-5"><div className="flex justify-between text-xs text-secondary mb-2"><span>{progress.label}</span><span>{Math.round(progress.current / progress.total * 100)}%</span></div><div className="h-1.5 bg-soft rounded-full overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${progress.current / progress.total * 100}%` }} /></div></div>}
      {error && <pre className="mt-4 text-xs leading-6 text-[#a25142] whitespace-pre-wrap">{error}</pre>}
      <Note>{t('uploadDialog.note')}</Note>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('uploadDialog.close')}</button>
        <button className="btn btn-primary" disabled={!files.length || !albumID || busy || (reviewing && pendingCount === 0)}>
          {busy ? <LoaderCircle className="icon animate-spin" /> : <UploadCloud className="icon" />}
          {busy ? (hashing ? t('uploadDialog.preparing') : t('uploadDialog.busy')) : reviewing ? t('upload.reviewContinue', { count: pendingCount }) : t('uploadDialog.submit', { count: files.length })}
        </button>
      </div>
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
      // Guests are not blocked on duplicates, but their files are hashed so the
      // organizer's import can skip ones the album already holds.
      setProgress(t('uploadDialog.preparing'));
      let hashes = new Map<File, string>();
      try { hashes = await hashFiles(files); }
      catch { /* hashing is optional here: upload without it rather than fail */ }
      for (let index = 0; index < files.length; index++) {
        setProgress(t('uploadDialog.progress', { index: index + 1, total: files.length, name: files[index].name }));
        try { await uploadGuestPhoto(files[index], message, { contentHash: hashes.get(files[index]) }); success++; }
        catch (reason) { errors.push(reason instanceof Error ? reason.message : t('uploadDialog.failed')); }
      }
      setBusy(false); onComplete(success, errors);
    }}>{busy ? <LoaderCircle className="icon animate-spin" /> : <UploadCloud className="icon" />}{busy ? t('uploadDialog.busy') : t('uploadDialog.submit', { count: files.length })}</button>
  </div>;
}
