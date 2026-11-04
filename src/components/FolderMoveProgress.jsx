import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FolderInput, X } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { formatCount } from '../utils/formatCount';
import { decodeImapUtf7 } from '../utils/imapUtf7';
import * as move from '../services/folderMove';

/** Counts that change within one state re-render the chip at most this often. */
export const RENDER_EVERY_MS = 1000;

// What decides the chip's words and buttons: a change here renders at once.
const shape = (p) => [p.state, p.active, p.error, p.sourceKeptReason, p.retiredTo, p.rateLimitedFor != null].join('|');

// The face a job shows. A job that is not active and not done (stopped by a
// quit, cancelled, failed, or done with the original kept) has a journal: it
// can be resumed or discarded.
function face(p) {
  if (p.state === 'done') return 'done';
  if (!p.active) return 'stopped';
  return p.state === 'paused' ? 'paused' : 'running';
}

const TITLE = {
  running: 'folderMove.titleRunning',
  verifying: 'folderMove.titleVerifying',
  retiring: 'folderMove.titleRetiring',
  paused: 'folderMove.titlePaused',
  stopped: 'folderMove.titleStopped',
  cancelled: 'folderMove.titleCancelled',
  failed: 'folderMove.titleFailed',
  partial: 'folderMove.titleKept',
  done: 'folderMove.titleDone',
};

// Why the original was kept (`sourceKeptReason`); a cancel says so in its title.
const KEPT = {
  unverified: 'folderMove.keptUnverified',
  failed: 'folderMove.keptFailed',
  no_trash: 'folderMove.keptNoTrash',
  rename_failed: 'folderMove.keptRenameFailed',
};

const byId = (list) => Object.fromEntries(list.filter((p) => p?.jobId).map((p) => [p.jobId, p]));
const without = (obj, ids) => Object.fromEntries(Object.entries(obj).filter(([id]) => !ids.includes(id)));

/**
 * Progress of a folder move: a corner chip, like the MBOX upload's, that
 * never blocks or steals focus. A progress event re-renders the chip alone,
 * and within one state at most once per RENDER_EVERY_MS. One row per job (one
 * job per account). Asks the daemon on start, and when it restarts, for jobs
 * a quit, a crash or a kept original left behind.
 */
export function FolderMoveProgress() {
  const [jobs, setJobs] = useState({});
  const [failed, setFailed] = useState({}); // jobId -> catalog key of a refused button
  const recheck = useRef(() => {});

  useEffect(() => {
    let alive = true;
    let timer = null;
    let events = 0;
    const pending = new Map();
    const committed = new Map(); // jobId -> shape last rendered
    const unlisteners = [];
    const keep = (p) => p.then((un) => { if (alive) unlisteners.push(un); else un?.(); });

    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (!alive || !pending.size) return;
      const batch = [...pending.values()];
      pending.clear();
      const moved = batch.filter((p) => committed.get(p.jobId) !== shape(p)).map((p) => p.jobId);
      for (const p of batch) committed.set(p.jobId, shape(p));
      setJobs((cur) => {
        const next = { ...cur };
        for (const p of batch) {
          if (p.state === 'discarded') delete next[p.jobId];
          else next[p.jobId] = p;
        }
        return next;
      });
      if (moved.length) setFailed((cur) => (moved.some((id) => cur[id]) ? without(cur, moved) : cur));
    };

    keep(move.onProgress((p) => {
      if (!p?.jobId) return;
      events += 1;
      pending.set(p.jobId, p);
      // The last event of a run: the reload is the raw event's, never a render's.
      if (!p.active) move.refreshAfter(p).catch((e) => console.warn('[folderMove] reload after the move failed:', e));
      if (!p.active || committed.get(p.jobId) !== shape(p)) flush();
      else if (!timer) timer = setTimeout(flush, RENDER_EVERY_MS);
    }));

    // `restarted`: the daemon came back and its view replaces ours, bar the
    // summaries of finished moves it has forgotten.
    const load = (restarted) => {
      if (restarted) {
        clearTimeout(timer);
        timer = null;
        pending.clear();
      }
      const before = events;
      move.status().then((list) => {
        if (!alive) return;
        if (restarted && events !== before) return;
        const known = byId(list);
        for (const p of Object.values(known)) committed.set(p.jobId, shape(p));
        setJobs((cur) => (restarted
          ? { ...Object.fromEntries(Object.entries(cur).filter(([, p]) => p.state === 'done')), ...known }
          : { ...known, ...cur }));
      }, (e) => console.warn('[folderMove] could not list the moves:', e?.message || e));
    };
    keep(move.onDaemonReconnected(() => load(true)));
    recheck.current = () => load(true);
    load(false);

    return () => { alive = false; clearTimeout(timer); unlisteners.forEach((un) => un?.()); };
  }, []);

  const drop = (jobId) => {
    setJobs((cur) => without(cur, [jobId]));
    setFailed((cur) => without(cur, [jobId]));
  };
  // The chip moves on the daemon's next event, not on the answer. An answer
  // of false means nothing was applied (the job is ending): ask again. A job
  // the daemon no longer has is gone; any other refusal is said in its row.
  const act = (jobId, run, answer, applied) => run().then(
    (reply) => {
      if (reply && reply[answer] === false) { recheck.current(); return; }
      setFailed((cur) => (cur[jobId] ? without(cur, [jobId]) : cur));
      applied?.();
    },
    (e) => {
      if (move.isNotFound(e)) { drop(jobId); return; }
      console.warn('[folderMove] the daemon refused:', e?.message || e);
      setFailed((cur) => ({ ...cur, [jobId]: move.errorKey(e) }));
    },
  );
  const controls = {
    pause: ({ jobId }) => act(jobId, () => move.pause(jobId), 'paused'),
    resume: ({ jobId }) => act(jobId, () => move.resume(jobId), 'resumed'),
    cancel: ({ jobId }) => act(jobId, () => move.cancel(jobId), 'cancelled'),
    // A journal with no worker sends no event: the row goes on the answer.
    discard: ({ jobId }) => act(jobId, () => move.discard(jobId), 'discarded', () => drop(jobId)),
    dismiss: ({ jobId }) => drop(jobId),
  };

  const list = Object.values(jobs);
  return (
    <AnimatePresence>
      {list.length > 0 && (
        <ToastShell position="bottom-left" role="presentation" bare data-testid="folder-move-chip"
          className="w-80 flex flex-col gap-2">
          {list.map((job) => <MoveRow key={job.jobId} job={job} failed={failed[job.jobId]} controls={controls} />)}
        </ToastShell>
      )}
    </AnimatePresence>
  );
}

function MoveRow({ job, failed, controls }) {
  const t = useT();
  const f = face(job);
  const name = decodeImapUtf7(job.sourcePath || '');
  const title = t(TITLE[job.state] || TITLE[f], { name });
  const handled = (job.copied || 0) + (job.skipped || 0) + (job.failed || 0);
  const percent = job.total > 0 ? Math.min(100, Math.floor((handled * 100) / job.total)) : 0;
  // A failed job keeps the original too, and says why in its error.
  const kept = job.state === 'partial' && KEPT[job.sourceKeptReason];
  const btn = (name, label, onClick, variant = 'secondary') => (
    <Button key={name} variant={variant} size="xs" data-testid={`folder-move-${name}`} onClick={() => onClick(job)}>{label}</Button>
  );

  return (
    <div data-testid="folder-move-job" data-job-id={job.jobId} data-state={f}
      className="bg-mail-surface border border-mail-border rounded-xl px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <FolderInput size={14} className="text-mail-accent-text flex-shrink-0 mt-0.5" />
        {/* Only this line is announced, and it changes only with the state. */}
        <p role="status" aria-live="polite" className="flex-1 min-w-0 font-medium text-mail-text break-words">{title}</p>
        {f === 'done' && (
          <Button variant="ghost" icon size="xs" aria-label={t('common.close')} data-testid="folder-move-dismiss" onClick={() => controls.dismiss(job)}>
            <X size={14} className="text-mail-text-muted" />
          </Button>
        )}
      </div>
      {/* A rename in place copies nothing: no counts to give. */}
      {(f !== 'done' || job.total > 0) && <p className="mt-1 text-xs text-mail-text-muted">
        {t('folderMove.counts', {
          copied: formatCount(job.copied || 0),
          skipped: formatCount(job.skipped || 0),
          failed: formatCount(job.failed || 0),
        })}
      </p>}
      {job.active && (
        <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={title}
          className="mt-2 h-1.5 rounded-full bg-mail-border overflow-hidden">
          <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      {job.active && job.rateLimitedFor != null && <p className="mt-1 text-xs text-mail-warning">{t('folderMove.rateLimited')}</p>}
      {job.retiredTo && <p className="mt-1 text-xs text-mail-text-muted">{t('folderMove.retiredTo', { path: decodeImapUtf7(job.retiredTo) })}</p>}
      {job.vaultRenameIncomplete && <p className="mt-1 text-xs text-mail-warning">{t('folderMove.vaultIncomplete')}</p>}
      {kept && <p className="mt-1 text-xs text-mail-warning">{t(kept)}</p>}
      {job.error && <p className="mt-1 text-xs text-mail-danger">{t(move.errorKey(job.error))}</p>}
      {f === 'stopped' && <p className="mt-1 text-xs text-mail-text-muted">{t('folderMove.stoppedHint')}</p>}
      {failed && <p className="mt-1 text-xs text-mail-danger">{t(failed)}</p>}
      {f !== 'done' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {f === 'running' && btn('pause', t('folderMove.pause'), controls.pause)}
          {(f === 'paused' || f === 'stopped') && btn('resume', t('common.resume'), controls.resume, 'primary')}
          {job.active && btn('cancel', t('common.cancel'), controls.cancel, 'ghost')}
          {f === 'stopped' && btn('discard', t('common.discard'), controls.discard, 'ghost')}
        </div>
      )}
    </div>
  );
}
