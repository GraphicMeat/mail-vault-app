import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Archive, Check, AlertCircle, Minimize2, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useAbdStore, selectPanelJob } from '../../stores/abdStore';
import { useAccountStore } from '../../stores/accountStore';
import * as abd from '../../services/abd';
import { isFinished, isBackupMode, keptReasons } from '../../utils/abdFrame';
import { formatBytes } from '../../utils/formatBytes';
import { formatCount } from '../../utils/formatCount';
import { statusText, KEPT_KEYS } from './abdText';
import { tErr, useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';

/**
 * The progress panel of an Archive & delete job (part-d design 6.4), in the
 * main window's corner. A non-blocking chip: never a modal, never takes focus.
 * Minimize tucks it into the pill; the job keeps running whatever happens to
 * the panel, the Settings window or the whole window, because the daemon owns
 * it. Only Cancel (behind its own confirmation) stops a job.
 */
export function AbdProgressPanel() {
  const panel = useAbdStore(s => s.panel);
  const job = useAbdStore(selectPanelJob);
  if (!panel || panel.minimized || !job) return null;
  return <PanelBody job={job} />;
}

/** One counter: "Checked in your vault  120 of 1,200" over a thin bar. */
function CounterRow({ label, done, total, testId }) {
  const t = useT();
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-mail-text-muted">{label}</span>
        <span className="text-mail-text tabular-nums">{t('abd.panel.progressOf', { done: formatCount(done), total: formatCount(total) })}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full overflow-hidden bg-mail-server-tint">
        <div className="h-full rounded-full bg-mail-local transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function PanelBody({ job }) {
  const t = useT();
  const pa = usePrivateAttr();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  // A job the daemon could not read sends no email: name the account from the list.
  const listedEmail = useAccountStore(s => (s.accounts || []).find(a => a.id === job.accountId)?.email);
  const accountEmail = job.accountEmail || listedEmail || '';

  // The footer swaps for the confirmation and back: focus goes with it, never to the page.
  const cancelButton = useRef(null);
  const keepRunningButton = useRef(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmingCancel) {
      wasConfirming.current = true;
      keepRunningButton.current?.focus();
    } else if (wasConfirming.current) {
      wasConfirming.current = false;
      cancelButton.current?.focus();
    }
  }, [confirmingCancel]);

  const counts = job.counts || {};
  const finished = isFinished(job);
  const state = job.status?.state;
  const paused = state === 'paused';
  const failed = state === 'failed';
  const backup = isBackupMode(job);
  const scoped = counts.scoped || 0;
  const kept = keptReasons(job);
  const statusLine = statusText(job);

  // One action at a time: a second click while the daemon answers the first does nothing.
  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try { await action(job.accountId); } catch (error) { setActionError(tErr(error)); } finally { setBusy(false); }
  };

  const close = async () => {
    // Closing a finished job removes its files; the panel goes with it.
    await run(abd.dismiss);
  };

  return (
    <motion.div
      data-testid="abd-panel"
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed bottom-4 right-4 z-50"
    >
      <div className={`bg-mail-surface border rounded-xl overflow-hidden w-[340px] max-w-[calc(100vw-2rem)]
                      ${failed ? 'border-mail-danger' : finished && state === 'completed' ? 'border-mail-local' : 'border-mail-strong'}`}>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-mail-border">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0
                            ${failed ? 'bg-mail-danger-tint' : finished ? 'bg-mail-local-tint' : 'bg-mail-accent/20'}`}>
              {failed ? <AlertCircle size={14} className="text-mail-danger" />
                : finished ? <Check size={14} className="text-mail-local" />
                  : <Archive size={14} className="text-mail-accent-text" />}
            </div>
            <span className="font-medium text-mail-text text-sm truncate" data-testid="abd-panel-title">
              {t(backup ? 'abd.panel.titleBackup' : 'abd.panel.title', { account: pa(accountEmail, 'email') })}
            </span>
          </div>
          {!finished && (
            <Button variant="ghost" icon size="xs" className="hover:bg-mail-border" data-testid="abd-minimize"
              onClick={() => useAbdStore.getState().minimize({ focusPill: true })} title={t('common.minimize')} aria-label={t('common.minimize')}>
              <Minimize2 size={14} className="text-mail-text-muted" />
            </Button>
          )}
          {finished && (
            <Button variant="ghost" icon size="xs" className="hover:bg-mail-border" data-testid="abd-close"
              disabled={busy} onClick={close} title={t('common.close')} aria-label={t('common.close')}>
              <X size={14} className="text-mail-text-muted" />
            </Button>
          )}
        </div>

        <div className="px-4 py-3 space-y-3">
          <p role="status" aria-live="polite" data-testid="abd-status" data-state={state} className={`text-sm ${failed ? 'text-mail-danger' : 'text-mail-text'}`}>
            {statusLine}
          </p>

          <div className="space-y-2">
            <CounterRow testId="abd-row-downloaded" label={t('abd.panel.downloaded')} done={counts.stored || 0} total={scoped} />
            <CounterRow testId="abd-row-vault" label={t('abd.panel.vaultVerified')} done={counts.vaultVerified || 0} total={scoped} />
            {backup && <CounterRow testId="abd-row-drive" label={t('abd.panel.onDrive')} done={counts.onDrive || 0} total={scoped} />}
            <CounterRow testId="abd-row-deleted" label={t('abd.panel.deleted')} done={counts.deleted || 0} total={scoped} />
            {job.deleteMode === 'move_to_trash_and_empty' && (
              <CounterRow testId="abd-row-emptied" label={t('abd.panel.emptied')} done={counts.emptied || 0} total={scoped} />
            )}
          </div>

          {!finished && job.daysLeft != null && job.dailyLimitBytes != null && (
            <p className="text-xs text-mail-text-muted" data-testid="abd-days-left">
              {t('abd.panel.daysLeft', { count: job.daysLeft, limit: formatBytes(job.dailyLimitBytes) })}
            </p>
          )}

          {(job.staleFolders || []).length > 0 && (
            <p className="text-xs text-mail-warning" data-testid="abd-stale">{t('abd.panel.folderChanged')}</p>
          )}

          {kept.length > 0 && (
            <details data-testid="abd-kept" className="text-xs">
              <summary className="cursor-pointer text-mail-text">{t('abd.panel.kept', { count: counts.kept || 0 })}</summary>
              <ul className="mt-1 space-y-0.5 text-mail-text-muted">
                {kept.map(([reason, count]) => (
                  <li key={reason} data-testid={`abd-kept-${reason}`} className="flex justify-between gap-3">
                    <span>{KEPT_KEYS[reason] ? t(KEPT_KEYS[reason]) : reason}</span>
                    <span className="tabular-nums">{formatCount(count)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {actionError && <p role="alert" className="text-xs text-mail-danger">{actionError}</p>}
        </div>

        {confirmingCancel && !finished && (
          <div className="px-4 py-3 bg-mail-danger/5 border-t border-mail-border" data-testid="abd-cancel-confirm">
            <p className="text-xs text-mail-text mb-2">{t('abd.action.cancelConfirm')}</p>
            <div className="flex gap-2">
              <Button ref={keepRunningButton} variant="secondary" size="xs" data-testid="abd-keep-running"
                onClick={() => setConfirmingCancel(false)}>{t('abd.action.keepRunning')}</Button>
              <Button variant="danger" size="xs" data-testid="abd-cancel-yes" disabled={busy}
                onClick={() => { setConfirmingCancel(false); run(abd.cancel); }}>{t('bulk.progress.yesStop')}</Button>
            </div>
          </div>
        )}

        {!finished && !confirmingCancel && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-mail-border">
            {paused ? (
              <Button variant="accentTint" size="xs" data-testid="abd-resume" disabled={busy} onClick={() => run(abd.resume)}>
                {t('common.resume')}
              </Button>
            ) : (
              <Button variant="secondary" size="xs" data-testid="abd-pause" disabled={busy} onClick={() => run(abd.pause)}>
                {t('abd.action.pause')}
              </Button>
            )}
            <Button ref={cancelButton} variant="ghost" size="xs" className="hover:text-mail-danger" data-testid="abd-cancel"
              onClick={() => setConfirmingCancel(true)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}

        {finished && (
          <div className="flex justify-end px-4 py-3 border-t border-mail-border">
            <Button variant="secondary" size="xs" data-testid="abd-done" disabled={busy} onClick={close}>{t('common.close')}</Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
