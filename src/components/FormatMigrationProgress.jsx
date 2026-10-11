import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FileJson, X } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { formatCount } from '../utils/formatCount';
import * as storageFormat from '../services/storageFormat';

// The face a conversion shows, read off the daemon's `migration` object
// (`storage_format_get`, `format-migration-progress`). A cancelled one shows
// none: Settings > Storage offers Resume and Convert back for it. A run a
// quit or a crash cut off reads as paused.
export function face(m) {
  if (!m) return null;
  if (m.state === 'done') return 'done';
  if (m.state === 'failed') return 'failed';
  if (m.state === 'paused') return 'paused';
  if (m.state === 'running' && m.active) return 'running';
  return null;
}

/**
 * The storage format conversion's corner chip: a background job that can run
 * for hours, never a modal and never blocking. It keeps its own state, fed by
 * the daemon's throttled progress events (at most four a second), so an event
 * re-renders the chip alone. Pause, Resume and Cancel steer the job; a run
 * that stopped on an error says why. Asks the daemon on start for a job a
 * quit or a crash left behind.
 */
export function FormatMigrationProgress() {
  const [job, setJob] = useState(null);
  // The job id of a finished chip the user closed.
  const [closed, setClosed] = useState(null);

  useEffect(() => {
    let alive = true;
    const unlisteners = [];
    const keep = (p) => p.then((un) => { if (alive) unlisteners.push(un); else un?.(); });
    const load = () => storageFormat.get().then(
      (info) => { if (alive) setJob(info?.migration || null); },
      (e) => console.warn('[formatMigration] state unavailable:', e?.message || e),
    );
    keep(storageFormat.onProgress((p) => { if (alive) setJob(p || null); }));
    keep(storageFormat.onDaemonReconnected(() => { if (alive) load(); }));
    load();
    return () => { alive = false; unlisteners.forEach((un) => un?.()); };
  }, []);

  const f = face(job);
  const visible = Boolean(f) && closed !== `${job.jobId}:${f}`;
  // The chip moves on the daemon's next event, not on the answer.
  const act = (call) => call().catch((e) => console.warn('[formatMigration] the daemon refused:', e?.message || e));

  return (
    <AnimatePresence>
      {visible && (
        <ToastShell position="bottom-left" role="presentation" bare data-testid="format-migration-chip" className="w-80">
          <MigrationRow job={job} f={f} act={act} onClose={() => setClosed(`${job.jobId}:${f}`)} />
        </ToastShell>
      )}
    </AnimatePresence>
  );
}

function MigrationRow({ job, f, act, onClose }) {
  const t = useT();
  let title = t('formatMigration.running');
  if (f === 'paused') title = t('formatMigration.paused');
  if (f === 'failed') title = t('formatMigration.failed');
  if (f === 'done') title = t('formatMigration.done');
  const done = job.done || 0;
  const total = job.total || 0;
  const percent = total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : 0;
  const btn = (name, label, onClick, variant = 'secondary') => (
    <Button key={name} variant={variant} size="xs" data-testid={`format-migration-${name}`} onClick={onClick}>{label}</Button>
  );

  return (
    <div data-testid="format-migration-job" data-state={f}
      className="bg-mail-surface border border-mail-border rounded-xl px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <FileJson size={14} className="text-mail-accent-text flex-shrink-0 mt-0.5" />
        {/* Only this line is announced, and it changes only with the state. */}
        <p role="status" aria-live="polite" className="flex-1 min-w-0 font-medium text-mail-text break-words">{title}</p>
        {(f === 'done' || f === 'failed') && (
          <Button variant="ghost" icon size="xs" aria-label={t('common.close')} data-testid="format-migration-close" onClick={onClose}>
            <X size={14} className="text-mail-text-muted" />
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-mail-text-muted" data-testid="format-migration-counts">
        {t('formatMigration.counts', { done: formatCount(done), total: formatCount(total) })}
      </p>
      {f !== 'done' && (
        <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={title}
          className="mt-2 h-1.5 rounded-full bg-mail-border overflow-hidden">
          <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      {f === 'failed' && (
        <p className="mt-1 text-xs text-mail-danger">{t('errors.formatFailed', { reason: storageFormat.failureText(job.error) })}</p>
      )}
      {f !== 'done' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {f === 'running' && btn('pause', t('settings.storage.convertPause'), () => act(storageFormat.pause))}
          {f !== 'running' && btn('resume', t('common.resume'), () => act(storageFormat.resume), 'primary')}
          {f !== 'failed' && btn('cancel', t('common.cancel'), () => act(storageFormat.cancel), 'ghost')}
        </div>
      )}
    </div>
  );
}
