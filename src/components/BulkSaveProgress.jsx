import { Button } from './ui/Button';
import React, { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';
import { motion, AnimatePresence } from 'framer-motion';
import { HardDrive, Check, X, AlertCircle, Download, Upload, FolderSymlink } from 'lucide-react';
import { mailboxLabel } from '../utils/imapUtf7';
import { t as tr, t, useT   } from '../i18n/index.js';

// Use targeted selectors to avoid re-rendering on every store change
const selectProgress = (s) => s.bulkSaveProgress;
const selectDismiss = (s) => s.dismissBulkProgress;
const selectCancel = (s) => s.cancelArchive;
const selectExportProgress = (s) => s.exportProgress;
const selectDismissExport = (s) => s.dismissExportProgress;
const selectMoveProgress = (s) => s.moveProgress;
const selectDismissMove = (s) => s.dismissMoveProgress;

export function BulkSaveProgress() {
  const bulkSaveProgress = useUiStore(selectProgress);
  const dismissBulkProgress = useUiStore(selectDismiss);
  const cancelArchive = useUiStore(selectCancel);
  const exportProgress = useUiStore(selectExportProgress);
  const dismissExportProgress = useUiStore(selectDismissExport);
  const moveProgress = useUiStore(selectMoveProgress);
  const dismissMoveProgress = useUiStore(selectDismissMove);

  // Show archive, move, or export/import progress (archive takes priority)
  const activeProgress = bulkSaveProgress || moveProgress || exportProgress;
  const mode = bulkSaveProgress ? 'archive'
    : moveProgress ? 'move'
      : (exportProgress?.mode || 'export');
  const dismiss = { archive: dismissBulkProgress, move: dismissMoveProgress }[mode] || dismissExportProgress;

  return (
    <AnimatePresence>
      {activeProgress && (
        <BulkSaveProgressInner
          progress={activeProgress}
          onDismiss={dismiss}
          onCancel={mode === 'archive' ? cancelArchive : null}
          mode={mode}
        />
      )}
    </AnimatePresence>
  );
}

const MODE_CONFIG = () => ({
  archive: {
    icon: HardDrive,
    activeLabel: tr('bulk.save.archivingEmails'),
    successLabel: tr('bulk.save.archivedSuccessfully'),
    errorLabel: (n) => `Archived with ${n} error(s)`,
  },
  export: {
    icon: Download,
    activeLabel: tr('bulk.save.exportingBackup'),
    successLabel: tr('bulk.save.backupExported'),
    errorLabel: (n) => `Exported with ${n} error(s)`,
  },
  import: {
    icon: Upload,
    activeLabel: tr('bulk.save.importingBackup'),
    successLabel: tr('bulk.save.backupImported'),
    errorLabel: (n) => `Imported with ${n} error(s)`,
  },
  move: {
    icon: FolderSymlink,
    activeLabel: tr('moveTo.moving'),
    // The only label here that names its subject, so it reads off the progress
    // object, and it is the same sentence the undo toast uses for this move.
    successLabel: (p) => tr('undo.moved', {
      count: p.completed,
      folder: mailboxLabel(String(p.folder || '').split(/[./]/).pop()),
    }),
    // Unreachable: a failed move clears moveProgress and reports inline.
    errorLabel: (n) => tr('settings.migration.emailsFailedCount', { count: n }),
  },
});

function BulkSaveProgressInner({ progress, onDismiss, onCancel, mode = 'archive' }) {
  const t = useT();
  const { total, completed, errors = 0, active } = progress;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  // Treat as complete when all emails are processed, even if active flag is stale
  const isComplete = total > 0 && completed + errors >= total;
  const base = MODE_CONFIG()[mode] || MODE_CONFIG().archive;
  const config = typeof base.successLabel === 'function'
    ? { ...base, successLabel: base.successLabel(progress) }
    : base;
  const Icon = config.icon;

  // Same reasoning as BulkOperationProgress: quarter milestones and the
  // outcome, never every percent.
  const milestone = Math.floor(percentage / 25) * 25;
  const of = t('bulk.progress.completedOfTotal', { completed: completed.toLocaleString(), total: total.toLocaleString() });
  const announcement = isComplete
    ? (errors > 0 ? t('bulk.save.messages', { config: config.errorLabel(errors), of }) : t('bulk.save.messages', { config: config.successLabel, of }))
    // activeLabel ends in an ellipsis for the eye; a screen reader would
    // read it out as "dot dot dot".
    : t('bulk.save.messages2', { config: config.activeLabel.replace(/\.\.\.$/, ''), milestone, total: total.toLocaleString() });

  useEffect(() => {
    if (isComplete && errors === 0) {
      const timer = setTimeout(() => {
        onDismiss();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, errors, onDismiss]);

  return (
    <motion.div
      key="bulk-save-progress"
      data-testid="bulk-save-progress"
      data-mode={mode}
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="fixed bottom-4 right-4 z-50"
    >
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <div className="bg-mail-surface border border-mail-strong rounded-xl
                     overflow-hidden min-w-[300px]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
          <div className="flex items-center gap-2">
            {isComplete ? (
              errors === 0 ? (
                <div className="w-6 h-6 bg-mail-success/20 rounded-full flex items-center justify-center">
                  <Check size={14} className="text-mail-success" />
                </div>
              ) : (
                <div className="w-6 h-6 bg-mail-warning/20 rounded-full flex items-center justify-center">
                  <AlertCircle size={14} className="text-mail-warning" />
                </div>
              )
            ) : (
              <div className="w-6 h-6 bg-mail-accent/20 rounded-full flex items-center justify-center">
                <Icon size={14} className="text-mail-accent-text" />
              </div>
            )}
            <span className="font-medium text-mail-text text-sm">
              {isComplete
                ? errors === 0
                  ? config.successLabel
                  : config.errorLabel(errors)
                : config.activeLabel}
            </span>
          </div>

          {isComplete ? (
            <Button variant="ghost" icon size="xs" className="hover:bg-mail-border"
              onClick={onDismiss}
            >
              <X size={14} className="text-mail-text-muted" />
            </Button>
          ) : onCancel ? (
            <Button variant="ghost" size="xs" className="hover:bg-mail-border hover:text-mail-danger"
              onClick={onCancel}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>

        {/* Progress */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-mail-text-muted">
              {t('bulk.progress.completedOfTotalEmails', { completed, total })}
            </span>
            <span className="text-sm font-medium text-mail-accent-text">
              {percentage}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-mail-border rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${percentage}%` }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className={`h-full rounded-full ${
                isComplete
                  ? errors === 0
                    ? 'bg-mail-success'
                    : 'bg-mail-warning'
                  : 'bg-mail-accent'
              }`}
            />
          </div>

          {/* Error count */}
          {errors > 0 && (
            <div className="mt-2 text-xs text-mail-danger">
              {errors} email(s) failed
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
