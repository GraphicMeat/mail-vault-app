import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { UploadCloud, X } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { formatCount } from '../utils/formatCount';
import * as upload from '../services/mboxUpload';

/** Counts that change within one state re-render the chip at most this often. */
export const RENDER_EVERY_MS = 1000;

// What decides the chip's words and buttons: a change here renders at once.
const shape = (p) => [p.state, p.active, p.paused, p.throttled, p.needsSignIn].join('|');

// The face a job shows, read off the daemon's own state. A job that is not
// active and not done (cancelled, cut off by a quit, unreadable) has a
// journal: it can be resumed or discarded.
function face(p) {
  if (p.state === 'done') return 'done';
  if (!p.active) return 'stopped';
  if (p.needsSignIn) return 'needsSignIn';
  if (p.paused) return 'paused';
  return p.throttled ? 'throttled' : 'running';
}

const TITLE = {
  running: 'mboxUpload.title',
  throttled: 'mboxUpload.title',
  paused: 'mboxUpload.titlePaused',
  needsSignIn: 'mboxUpload.titlePaused',
  stopped: 'mboxUpload.titleStopped',
  done: 'mboxUpload.titleDone',
};

const byId = (list) => Object.fromEntries(list.map((p) => [p.jobId, p]));
const without = (obj, ids) => Object.fromEntries(Object.entries(obj).filter(([id]) => !ids.includes(id)));

/**
 * Progress of an MBOX upload to the server (import mode 1): a corner chip,
 * like the indexing chip, that never blocks or steals focus. The job can run
 * for hours, so the chip keeps its own state and a progress event re-renders
 * the chip alone, and within one state at most once per RENDER_EVERY_MS.
 * One row per job (one job per account). Asks the daemon on start for jobs a
 * quit or a crash left behind.
 */
export function MboxUploadProgress({ onOpenAccounts }) {
  const [jobs, setJobs] = useState({});
  const [failed, setFailed] = useState({}); // jobId -> catalog key of a refused button

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
      // A job that changed state has moved past a refused button's words.
      if (moved.length) setFailed((cur) => (moved.some((id) => cur[id]) ? without(cur, moved) : cur));
    };

    keep(upload.onProgress((p) => {
      events += 1;
      pending.set(p.jobId, p);
      // The last event of a run: the reload is the raw event's, never a render's.
      if (!p.active) upload.refreshAfter(p).catch((e) => console.warn('[mboxUpload] reload after the upload failed:', e));
      if (!p.active || committed.get(p.jobId) !== shape(p)) flush();
      else if (!timer) timer = setTimeout(flush, RENDER_EVERY_MS);
    }));

    // `restarted`: the daemon came back and its view replaces ours, bar the
    // summaries of runs it has forgotten. Either way an event that landed
    // while the list was on its way is newer than the list.
    const load = (restarted) => {
      const before = events;
      upload.status().then((list) => {
        if (!alive) return;
        if (restarted && events !== before) return;
        for (const p of list) committed.set(p.jobId, shape(p));
        setJobs((cur) => (restarted
          ? { ...Object.fromEntries(Object.entries(cur).filter(([, p]) => p.state === 'done')), ...byId(list) }
          : { ...byId(list), ...cur }));
      }, (e) => console.warn('[mboxUpload] could not list the uploads:', e?.message || e));
    };
    keep(upload.onDaemonReconnected(() => load(true)));
    load(false);

    return () => { alive = false; clearTimeout(timer); unlisteners.forEach((un) => un?.()); };
  }, []);

  const drop = (jobId) => {
    setJobs((cur) => without(cur, [jobId]));
    setFailed((cur) => without(cur, [jobId]));
  };
  // The chip moves on the daemon's next event, not on the answer. A job the
  // daemon no longer has is gone; any other refusal is said in its row.
  const act = (jobId, run) => run().then(
    () => setFailed((cur) => (cur[jobId] ? without(cur, [jobId]) : cur)),
    (e) => {
      if (upload.isNotFound(e)) { drop(jobId); return; }
      console.warn('[mboxUpload] the daemon refused:', e?.message || e);
      setFailed((cur) => ({ ...cur, [jobId]: upload.errorKey(e, 'mboxUpload.actionFailed') }));
    },
  );
  const controls = {
    pause: ({ jobId }) => act(jobId, () => upload.pause(jobId)),
    resume: ({ jobId, accountId }) => act(jobId, () => upload.resume({ jobId, accountId })),
    cancel: ({ jobId }) => act(jobId, () => upload.cancel(jobId)),
    // A journal with no worker sends no event: the row goes on the answer.
    discard: ({ jobId }) => act(jobId, () => upload.discard(jobId).then(() => drop(jobId))),
    dismiss: ({ jobId }) => drop(jobId),
    signIn: onOpenAccounts && (({ accountId }) => onOpenAccounts(accountId)),
  };

  const list = Object.values(jobs);
  return (
    <AnimatePresence>
      {list.length > 0 && (
        <ToastShell position="bottom-left" role="presentation" bare data-testid="mbox-upload-chip"
          className="w-80 flex flex-col gap-2">
          {list.map((job) => <UploadRow key={job.jobId} job={job} failed={failed[job.jobId]} controls={controls} />)}
        </ToastShell>
      )}
    </AnimatePresence>
  );
}

// The daemon's seconds left, in hours and minutes. Only ever the daemon's
// number: the app does not estimate.
function etaWords(secs) {
  if (secs < 60) return { etaKey: 'mboxUpload.etaUnderMinute' };
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  return hours ? { etaKey: 'mboxUpload.etaHours', hours, minutes } : { etaKey: 'mboxUpload.etaMinutes', minutes };
}

function UploadRow({ job, failed, controls }) {
  const t = useT();
  const f = face(job);
  const id = job.jobId;
  const title = t(TITLE[f], { file: job.fileName || '' });
  const percent = job.bytesTotal > 0 ? Math.min(100, Math.floor((job.bytesDone * 100) / job.bytesTotal)) : 0;
  const eta = typeof job.etaSeconds === 'number' ? etaWords(job.etaSeconds) : null;
  const live = f === 'running' || f === 'throttled';
  const held = f === 'paused' || f === 'needsSignIn';
  const btn = (name, label, onClick, variant = 'secondary') => (
    <Button key={name} variant={variant} size="xs" data-testid={`mbox-upload-${name}`} onClick={() => onClick(job)}>{label}</Button>
  );

  return (
    <div data-testid="mbox-upload-job" data-job-id={id} data-state={f}
      className="bg-mail-surface border border-mail-border rounded-xl px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <UploadCloud size={14} className="text-mail-accent-text flex-shrink-0 mt-0.5" />
        {/* Only this line is announced, and it changes only with the state. */}
        <p role="status" aria-live="polite" className="flex-1 min-w-0 font-medium text-mail-text break-words">{title}</p>
        {f === 'done' && (
          <Button variant="ghost" icon size="xs" aria-label={t('common.close')} data-testid="mbox-upload-dismiss" onClick={() => controls.dismiss(job)}>
            <X size={14} className="text-mail-text-muted" />
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-mail-text-muted">
        {t('mboxUpload.counts', {
          uploaded: formatCount(job.uploadedCount || 0),
          skipped: formatCount(job.skippedCount || 0),
          failed: formatCount(job.failedCount || 0),
        })}
      </p>
      {f !== 'done' && (
        <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={title}
          className="mt-2 h-1.5 rounded-full bg-mail-border overflow-hidden">
          <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      {eta && <p className="mt-1 text-xs text-mail-text-muted">{t(eta.etaKey, eta)}</p>}
      {f === 'throttled' && <p className="mt-1 text-xs text-mail-warning">{t('mboxUpload.throttled')}</p>}
      {job.needsSignIn && <p className="mt-1 text-xs text-mail-warning">{t('mboxUpload.needsSignIn')}</p>}
      {job.error && <p className="mt-1 text-xs text-mail-danger">{t(upload.errorKey(job.error))}</p>}
      {failed && <p className="mt-1 text-xs text-mail-danger">{t(failed)}</p>}
      {f !== 'done' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {job.needsSignIn && controls.signIn && btn('sign-in', t('mboxUpload.signIn'), controls.signIn)}
          {live && btn('pause', t('mboxUpload.pause'), controls.pause)}
          {(held || f === 'stopped') && btn('resume', t('common.resume'), controls.resume, 'primary')}
          {(live || held) && btn('cancel', t('common.cancel'), controls.cancel, 'ghost')}
          {f === 'stopped' && btn('discard', t('common.discard'), controls.discard, 'ghost')}
        </div>
      )}
    </div>
  );
}
