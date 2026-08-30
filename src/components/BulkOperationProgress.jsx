import { Button } from './ui/Button';
import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HardDrive, Trash2, Check, AlertCircle, Minimize2, Maximize2, X, Shield
} from 'lucide-react';
import { t as tr, t, useT   } from '../i18n/index.js';

const PHASE_LABELS = () => ({
  archive: tr('bulk.progress.downloading'),
  verify: tr('bulk.progress.verifying'),
  delete: tr('bulk.progress.deleting'),
  vault: tr('bulk.progress.removingVault'),
  backup: tr('bulk.progress.clearingBackup'),
});

const PHASE_ICONS = {
  archive: HardDrive,
  verify: Check,
  delete: Trash2,
  vault: HardDrive,
  backup: Shield,
};

export function BulkOperationProgress({ operation, onCancel, onDismiss }) {
  const t = useT();
  const [minimized, setMinimized] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const handleDismiss = useCallback(() => {
    if (onDismiss) onDismiss();
  }, [onDismiss]);

  const status = operation?.status;
  const currentPhase = operation?.currentPhase;
  const total = operation?.total ?? 0;
  const completed = operation?.completed ?? 0;
  const errors = operation?.errors ?? 0;
  const type = operation?.type;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isComplete = status === 'complete';
  const isCancelled = status === 'cancelled';
  const isError = status === 'error';
  const isActive = ['archiving', 'verifying', 'deleting'].includes(status);
  const isDone = isComplete || isCancelled || isError;

  // Auto-dismiss after 4s on success
  useEffect(() => {
    if (isComplete && errors === 0) {
      const timer = setTimeout(handleDismiss, 4000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, errors, handleDismiss]);

  if (!operation) return null;

  // Determine phase count for display
  const totalPhases = type === 'archive_and_delete' ? 2 : 1;
  // Custody colours only when the operation really does move mail into the vault.
  // A delete (or delete_everywhere) is not "server becoming vault".
  const movesToVault = type === 'archive' || type === 'archive_and_delete';
  const currentPhaseNum = currentPhase === 'delete' && type === 'archive_and_delete' ? 2 : 1;

  const PhaseIcon = PHASE_ICONS[currentPhase] || HardDrive;
  const phaseLabel = PHASE_LABELS()[currentPhase] || 'Processing';

  // Thousands of messages leave the server here, and until now the whole
  // operation was silent to a screen reader — the bar is the only report it
  // makes. Announce phase changes, quarter milestones and the outcome; not
  // every percent, which would talk over the user for the whole run.
  const milestone = Math.floor(percentage / 25) * 25;
  const of = t('bulk.progress.completedOfTotal', { completed: completed.toLocaleString(), total: total.toLocaleString() });
  const announcement = isComplete
    ? (errors > 0 ? t('bulk.progress.finishedFailedMessages', { errors: errors.toLocaleString(), of }) : t('bulk.progress.finishedMessages', { of }))
    : isCancelled ? t('bulk.progress.cancelledMessages', { of })
    : isError ? t('bulk.progress.stoppedErrorMessages', { of })
    : t('bulk.progress.messages', { phaseLabel, milestone, total: total.toLocaleString() });
  const liveRegion = <p role="status" aria-live="polite" className="sr-only">{announcement}</p>;

  if (!isActive && !isComplete && !isCancelled && !isError) return null;

  // Minimized view
  if (minimized && isActive) {
    return (
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="fixed bottom-4 right-4 z-50"
      >
        {liveRegion}
        <button
          onClick={() => setMinimized(false)}
          className="flex items-center gap-2 px-3 py-2 bg-mail-surface border border-mail-strong
                    rounded-lg hover:bg-mail-surface-hover transition-colors"
        >
          <PhaseIcon size={14} className="text-mail-accent-text animate-pulse" />
          <span className="text-sm text-mail-text">{phaseLabel}... {percentage}%</span>
          <Maximize2 size={12} className="text-mail-text-muted" />
        </button>
      </motion.div>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        key="bulk-op-progress"
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        className="fixed bottom-4 right-4 z-50"
      >
        {liveRegion}
        <div className={`bg-mail-surface border rounded-xl overflow-hidden min-w-[320px]
                        transition-[border-color] duration-[var(--mv-transition)]
                        ${isError ? 'border-mail-danger' : isComplete && movesToVault ? 'border-mail-local' : 'border-mail-strong'}`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
            <div className="flex items-center gap-2">
              {isComplete ? (
                /* The last frame of a bulk run is the product's promise being
                   kept — these messages are on your disk and the server can be
                   emptied now. One beat, and in Vault Emerald when the run is
                   the one that moved mail into the vault. */
                <div className={`op-landed w-6 h-6 rounded-full flex items-center justify-center
                                ${movesToVault ? 'bg-mail-local-tint' : 'bg-mail-success-tint'}`}>
                  <Check size={14} className={movesToVault ? 'text-mail-local' : 'text-mail-success'} />
                </div>
              ) : isError ? (
                <div className="op-landed w-6 h-6 bg-mail-danger-tint rounded-full flex items-center justify-center">
                  <AlertCircle size={14} className="text-mail-danger" />
                </div>
              ) : (
                <div className="w-6 h-6 bg-mail-accent/20 rounded-full flex items-center justify-center">
                  <PhaseIcon size={14} className="text-mail-accent-text" />
                </div>
              )}
              <span className="font-medium text-mail-text text-sm">
                {isComplete
                  ? t('bulk.progress.operationComplete')
                  : isCancelled
                    ? t('bulk.progress.operationCancelled')
                    : isError
                      ? t('bulk.progress.operationFailed')
                      : totalPhases > 1
                        ? t('bulk.progress.phase', { currentPhaseNum, totalPhases, phaseLabel })
                        : phaseLabel}
              </span>
            </div>

            <div className="flex items-center gap-1">
              {isDone ? (
                <Button variant="ghost" icon size="xs" className="hover:bg-mail-border"
                  onClick={handleDismiss}
                >
                  <X size={14} className="text-mail-text-muted" />
                </Button>
              ) : isActive ? (
                <>
                  <Button variant="ghost" icon size="xs" className="hover:bg-mail-border"
                    onClick={() => setMinimized(true)}
                    title={t('common.minimize')}
                  >
                    <Minimize2 size={14} className="text-mail-text-muted" />
                  </Button>
                  <Button variant="ghost" size="xs" className="hover:bg-mail-border hover:text-mail-danger"
                    onClick={() => setShowCancelConfirm(true)}
                  >
                    {t('common.cancel')}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {/* Cancel confirmation */}
          {showCancelConfirm && (
            <div className="px-4 py-3 bg-mail-danger/5 border-b border-mail-border">
              <p className="text-xs text-mail-text mb-2">{t('bulk.progress.cancelOperationAlreadyArchivedEmails')}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="px-3 py-1 text-xs bg-mail-surface border border-mail-border rounded-lg
                            hover:bg-mail-surface-hover transition-colors text-mail-text"
                >
                  {t('bulk.progress.continue')}
                </button>
                <button
                  onClick={() => { setShowCancelConfirm(false); onCancel(); }}
                  className="px-3 py-1 text-xs bg-mail-danger text-white rounded-lg
                            hover:bg-mail-danger/90 transition-colors"
                >
                  {t('bulk.progress.yesStop')}
                </button>
              </div>
            </div>
          )}

          {/* Progress */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-mail-text-muted">
                {t('bulk.progress.completedOfTotalEmails', { completed: completed.toLocaleString(), total: total.toLocaleString() })}
              </span>
              <span className="text-sm font-medium text-mail-accent-text">
                {percentage}%
              </span>
            </div>

            {/* When the operation moves mail into the vault, the track IS the
                custody story: the filled part is Vault Emerald (this many are
                on your disk now) over a Server Blue field (this many are still
                only on the server). Every other operation gets a plain accent
                bar. A failed run drops out of the story into danger. */}
            <div className={`h-2 rounded-full overflow-hidden ${movesToVault ? 'bg-mail-server-tint' : 'bg-mail-surface-hover'}`}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${percentage}%` }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                className={`h-full rounded-full ${isError ? 'bg-mail-danger' : movesToVault ? 'bg-mail-local' : 'bg-mail-accent'}`}
              />
            </div>

            {errors > 0 && (
              <div className="mt-2 text-xs text-mail-danger">
                {operation?.lastError || `${errors} email(s) failed`}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
