import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, CircleDot, CircleDashed, Clock3, ImagePlus, Pause, Play, RotateCcw, ScanSearch, Trash2, UploadCloud, X } from 'lucide-react';
import { formatSize } from '../lib/api';
import { useT } from '../lib/i18n';
import { Empty } from './ui';
import { usePageTitleScroll } from './HeaderTitleContext';
import { useQueue, useSummary, useCompletedTick, removeRecord } from '../lib/queue/store';
import { uploadedBytes, type QueueRecord, type QueueStatus } from '../lib/queue/types';
import { cancel, isPaused, pause, previewUrl, releasePreview, resume, retry } from '../lib/queue/runner';

/** Only this many rows per group are rendered until the user asks for more. */
const GROUP_LIMIT = 50;

/**
 * The queue shows two phases rather than one row per internal status.
 *
 * "Preparing" is everything the user cannot see progress in: hashing, the
 * duplicate lookup, opening the session, decoding for the preview. "Uploading"
 * is when bytes actually move, and the only phase where a size counter means
 * anything at all.
 */
const PREPARING: QueueStatus[] = ['waiting', 'queued', 'hashing', 'checking', 'creating'];
const UPLOADING: QueueStatus[] = ['uploading', 'deriving', 'completing'];

const STATUS_KEY: Record<QueueStatus, string> = {
  waiting: 'queue.statusWaitingSource',
  queued: 'queue.statusWaiting',
  hashing: 'queue.statusHashing',
  checking: 'queue.statusChecking',
  creating: 'queue.statusCreating',
  uploading: 'queue.statusUploading',
  deriving: 'queue.statusDeriving',
  completing: 'queue.statusCompleting',
  done: 'queue.statusDone',
  skipped: 'queue.statusSkipped',
  failed: 'queue.statusFailed',
};

/**
 * A status icon, never a spinner.
 *
 * Thirty spinning rings are thirty compositor animations plus the repaint of
 * whatever they cover, and none of them says anything the words do not. The icon
 * carries the *kind* of row; the colour carries where it is; the label carries
 * the rest.
 */
const STATUS_ICON: Record<QueueStatus, typeof Clock3> = {
  waiting: CircleDashed,
  queued: Clock3,
  hashing: CircleDot,
  checking: CircleDot,
  creating: CircleDot,
  uploading: CircleDot,
  deriving: CircleDot,
  completing: CircleDot,
  done: CircleDot,
  skipped: ScanSearch,
  failed: AlertTriangle,
};

type Group = { id: string; titleKey: string; icon: typeof Clock3; records: QueueRecord[] };

export function UploadQueuePage({ onAdd, onReattach, onToast }: {
  onAdd: () => void;
  /** Asks the shell to reopen a folder picker for a batch that lost its source. */
  onReattach: (sessionId: string) => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const records = useQueue();
  // Completion removes the row, so the tick is what re-renders the bar after it goes.
  useCompletedTick();
  const titleRef = usePageTitleScroll(t('queue.title'));
  // First-level destination: it has its own dock entry, so no back button. Setting
  // one would also hide the dock, and the queue must stay reachable from anywhere
  // while it is working.
  const [paused, setPaused] = useState(isPaused());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Only the row list depends on `records`. The bar reads the summary, which is
  // published per batch rather than per paint, so grouping here is the one
  // derived value left on this component.
  const groups = useMemo<Group[]>(() => {
    const pick = (statuses: QueueStatus[]) => records.filter(record => statuses.includes(record.status));
    // Uploading first: that is the phase with a live byte counter, so it is the
    // one worth keeping at the top of the list.
    return [
      { id: 'uploading', titleKey: 'queue.phaseUploading', icon: UploadCloud, records: pick(UPLOADING) },
      { id: 'preparing', titleKey: 'queue.phasePreparing', icon: Clock3, records: pick(PREPARING) },
      { id: 'failed', titleKey: 'queue.needsAction', icon: AlertTriangle, records: pick(['failed']) },
      { id: 'skipped', titleKey: 'queue.skippedList', icon: ScanSearch, records: pick(['skipped']) },
    ];
  }, [records]);

  const hasWork = records.some(record => PREPARING.includes(record.status) || UPLOADING.includes(record.status));

  const togglePause = () => {
    if (paused) { resume(); setPaused(false); } else { pause(); setPaused(true); }
  };

  if (!records.length) {
    return <div className="page">
      <div ref={titleRef} className="mb-6">
        <h1 className="page-title">{t('queue.title')}<span className="text-accent">.</span></h1>
        <p className="page-description">{t('queue.description')}</p>
      </div>
      <Empty
        icon={<UploadCloud className="w-8 h-8" />}
        title={t('queue.empty')}
        description={t('queue.description')}
        action={<button className="btn btn-primary" onClick={onAdd}><ImagePlus className="icon" />{t('queue.addMore')}</button>}
      />
    </div>;
  }

  return <div className="page">
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5 mb-6">
      <div ref={titleRef}>
        <h1 className="page-title">{t('queue.title')}<span className="text-accent">.</span></h1>
        <p className="page-description">{t('queue.description')}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {hasWork && <button className="btn btn-secondary" onClick={togglePause}>
          {paused ? <Play className="icon" /> : <Pause className="icon" />}{t(paused ? 'queue.resume' : 'queue.pause')}
        </button>}
        <button className="btn btn-primary" onClick={onAdd}><ImagePlus className="icon" />{t('queue.addMore')}</button>
      </div>
    </div>

    {/* One bar for the whole queue. Its own component, and its own subscription:
        progress is the only thing that changes often, so it re-renders alone and
        the rows (and their thumbnails) keep their identity. */}
    <QueueProgress paused={paused} />

    {groups.filter(group => group.records.length).map(group => {
      const open = expanded[group.id];
      const shown = open ? group.records : group.records.slice(0, GROUP_LIMIT);
      const hidden = group.records.length - shown.length;
      return <section key={group.id} className="mb-8">
        <h2 className="flex items-center gap-2 text-xs font-medium text-secondary mb-3">
          <group.icon className="icon w-4 h-4" />
          {t(group.titleKey)}
          <small className="text-muted font-normal">{group.records.length}</small>
        </h2>
        <ul className="queue-list">
          {shown.map(record => <QueueRow key={record.id} record={record} onReattach={onReattach} onToast={onToast} />)}
        </ul>
        {hidden > 0 && <button className="mt-3 text-[11px] text-muted hover:text-ink transition-colors inline-flex items-center gap-1.5" onClick={() => setExpanded(previous => ({ ...previous, [group.id]: true }))}>
          <ChevronDown className="w-3.5 h-3.5" />{t('queue.showAll', { count: group.records.length })}
        </button>}
        {open && group.records.length > GROUP_LIMIT && <button className="mt-3 text-[11px] text-muted hover:text-ink transition-colors" onClick={() => setExpanded(previous => ({ ...previous, [group.id]: false }))}>{t('queue.showLess')}</button>}
      </section>;
    })}

    <style>{`
      .queue-bar{height:6px;border-radius:999px;overflow:hidden;background:var(--color-soft)}
      .queue-bar-fill{height:100%;border-radius:inherit;background:var(--color-accent)}
      /* Width only ever grows during a batch, so the browser can animate it
         without a keyframe. Long enough to hide the jump between part
         acknowledgements, short enough to still feel live. */
      .queue-bar-fill{transition:width .5s linear}
      @media (prefers-reduced-motion: reduce){.queue-bar-fill{transition:none}}
      .queue-list{border:1px solid var(--color-line);border-radius:14px;overflow:hidden;background:var(--color-surface)}
      .queue-list>li+li{border-top:1px solid var(--color-line)}
      .queue-row{display:flex;align-items:center;gap:12px;padding:10px 12px}
      .queue-thumb{width:42px;height:42px;border-radius:9px;overflow:hidden;flex-shrink:0;display:grid;place-items:center;background:var(--color-soft)}
      .queue-thumb img{width:100%;height:100%;object-fit:cover;display:block}
      .queue-row-action{width:32px;height:32px;display:grid;place-items:center;border-radius:8px;color:var(--color-muted);background:transparent;border:0;transition:background .15s,color .15s}
      .queue-row-action:hover{background:var(--color-soft);color:var(--color-ink)}
    `}</style>
  </div>;
}

/**
 * One bar for the whole batch.
 *
 * Its own component on purpose: this is the only part of the page that changes
 * every few hundred milliseconds, so it subscribes to the summary alone and a
 * part landing re-renders this and nothing else. The rows keep their identity,
 * so no thumbnail is re-fetched.
 *
 * The fill is bytes actually at the bucket: it holds still while files are
 * being prepared and only moves when data moves. The label says which phase is
 * busy so a motionless bar is never read as a stall, and it never swaps between
 * two scales — that swap is what made the old bar look like it was moving
 * backwards.
 */
function QueueProgress({ paused }: { paused: boolean }) {
  const t = useT();
  const summary = useSummary();
  const percent = summary.totalBytes ? Math.min(100, summary.sent / summary.totalBytes * 100) : 0;
  // One scale from start to finish: files settled, out of the batch's size.
  const settled = summary.total - summary.active;
  const label = summary.uploading > 0
    ? t('queue.bytes', { done: formatSize(summary.sent), total: formatSize(summary.totalBytes) })
    : t('queue.progress', { done: settled, total: summary.total });

  return <div className="mb-7">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2.5 text-[11px]">
      <span className="text-secondary tabular-nums">{label}</span>
      {summary.uploading > 0 && summary.preparing > 0 && <span className="text-muted">{t('queue.phasePreparingCount', { done: settled, total: summary.total })}</span>}
      {paused && <span className="text-[#a2663d]">{t('queue.pausedNotice')}</span>}
      {summary.failed > 0 && <span className="text-[#a25142]">{t('queue.failedCount', { count: summary.failed })}</span>}
      {summary.skipped > 0 && <span className="text-muted">{t('queue.skippedCount', { count: summary.skipped })}</span>}
    </div>
    <div className="queue-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <div className="queue-bar-fill" style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

function QueueRow({ record, onReattach, onToast }: { record: QueueRecord; onReattach: (sessionId: string) => void; onToast: (message: string) => void }) {
  const t = useT();
  const [thumb, setThumb] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Every row gets a thumbnail: recognising the file is the point of showing
    // it. The effect keys off the record's identity only, so a progress update
    // cannot unmount the image and make the browser fetch it again.
    previewUrl(record).then(url => { if (mounted.current && url) setThumb(url); }).catch(() => undefined);
    return () => {
      mounted.current = false;
      setThumb(null);
      releasePreview(record.id);
    };
  }, [record.id, record.sourceKey]);

  const transferred = uploadedBytes(record);
  const label = record.status === 'waiting' ? t('queue.statusWaiting') : t(STATUS_KEY[record.status]);
  const uploading = UPLOADING.includes(record.status);
  const active = uploading || PREPARING.includes(record.status);
  // A status icon, never a spinner: the icon says what kind of row this is and
  // the colour says where it is; the words underneath say the rest.
  const Icon = STATUS_ICON[record.status];
  const tone = record.status === 'failed' ? 'text-[#a25142]'
    : record.status === 'skipped' ? 'text-muted'
    : record.status === 'waiting' ? 'text-muted'
    : 'text-accent';
  // Only the bytes phase has a meaningful counter; preparing shows the size it is
  // about to send rather than a fake "0 / N".
  const detail = uploading && transferred > 0 && transferred < record.size
    ? `${formatSize(transferred)} / ${formatSize(record.size)}`
    : formatSize(record.size);

  return <li className="queue-row">
    <span className="queue-thumb">
      {thumb ? <img src={thumb} alt="" draggable={false} decoding="async" /> : <ImagePlus className="icon w-4 h-4 text-muted" />}
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5 text-xs text-ink">
        <span className="truncate">{label}</span>
        {record.status === 'failed' && record.error && <span className="truncate text-[10px] text-[#a25142]">{record.error}</span>}
      </span>
      <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
        <span className="truncate max-w-[45%]">{record.name}</span>
        <span className="shrink-0 tabular-nums">{detail}</span>
      </span>
    </span>
    <span className="shrink-0 flex items-center gap-0.5">
      {record.status === 'waiting' && <button className="text-[11px] text-accent hover:underline px-1" onClick={() => onReattach(record.sessionId)}>{t('queue.reattach')}</button>}
      {record.status === 'failed' && <button className="queue-row-action" onClick={() => retry(record.id)} aria-label={t('queue.retry')} title={t('queue.retry')}><RotateCcw className="icon w-4 h-4" /></button>}
      {(record.status === 'skipped' || record.status === 'failed') && <button className="queue-row-action" onClick={() => { void removeRecord(record.id); releasePreview(record.id); }} aria-label={t('queue.cancel')} title={t('queue.cancel')}><X className="icon w-4 h-4" /></button>}
      {active && <button className="queue-row-action" onClick={() => { cancel(record.id).catch(reason => onToast(reason instanceof Error ? reason.message : t('queue.failedGeneric'))); }} aria-label={t('queue.cancel')} title={t('queue.cancel')}><Trash2 className="icon w-4 h-4" /></button>}
      <Icon className={`icon w-4 h-4 ml-1 ${tone}`} />
    </span>
  </li>;
}
