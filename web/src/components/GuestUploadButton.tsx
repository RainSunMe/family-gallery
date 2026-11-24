import { useState } from 'react';
import { LoaderCircle, UploadCloud } from 'lucide-react';
import { uploadGuestPhoto } from '../lib/upload';
import { hashFiles } from '../lib/hash';
import { useT } from '../lib/i18n';

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
