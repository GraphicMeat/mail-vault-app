import React from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { HardDrive, Check, X, AlertCircle, Download, Upload } from 'lucide-react';

// Use targeted selectors to avoid re-rendering on every store change
const selectProgress = (s) => s.bulkSaveProgress;
const selectDismiss = (s) => s.dismissBulkProgress;
const selectCancel = (s) => s.cancelArchive;
const selectExportProgress = (s) => s.exportProgress;
const selectDismissExport = (s) => s.dismissExportProgress;

export function BulkSaveProgress() {
  const bulkSaveProgress = useMailStore(selectProgress);
  const dismissBulkProgress = useMailStore(selectDismiss);
  const cancelArchive = useMailStore(selectCancel);
  const exportProgress = useMailStore(selectExportProgress);
  const dismissExportProgress = useMailStore(selectDismissExport);

  // Show archive progress or export/import progress (archive takes priority)
  const activeProgress = bulkSaveProgress || exportProgress;
  const isExportMode = !bulkSaveProgress && !!exportProgress;

  return (
    <AnimatePresence>
      {activeProgress && (
        <BulkSaveProgressInner
          progress={activeProgress}
          onDismiss={isExportMode ? dismissExportProgress : dismissBulkProgress}
          onCancel={isExportMode ? null : cancelArchive}
          mode={isExportMode ? (exportProgress.mode || 'export') : 'archive'}
        />
      )}
    </AnimatePresence>
  );
}

const MODE_CONFIG = {
  archive: {
    icon: HardDrive,
    activeLabel: 'Archiving Emails...',
    successLabel: 'Archived Successfully',
    errorLabel: (n) => `Archived with ${n} error(s)`,
  },
  export: {
    icon: Download,
    activeLabel: 'Exporting Backup...',
    successLabel: 'Backup Exported',
    errorLabel: (n) => `Exported with ${n} error(s)`,
  },
  import: {
    icon: Upload,
    activeLabel: 'Importing Backup...',
    successLabel: 'Backup Imported',
    errorLabel: (n) => `Imported with ${n} error(s)`,
  },
};

function BulkSaveProgressInner({ progress, onDismiss, onCancel, mode = 'archive' }) {
  const { total, completed, errors = 0, active } = progress;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isComplete = !active && completed + errors >= total;
  const config = MODE_CONFIG[mode] || MODE_CONFIG.archive;
  const Icon = config.icon;

  return (
    <motion.div
      key="bulk-save-progress"
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="fixed bottom-4 right-4 z-50"
    >
      <div className="bg-mail-surface border border-mail-border rounded-xl shadow-2xl
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
                <Icon size={14} className="text-mail-accent" />
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
            <button
              onClick={onDismiss}
              className="p-1 hover:bg-mail-border rounded transition-colors"
            >
              <X size={14} className="text-mail-text-muted" />
            </button>
          ) : onCancel ? (
            <button
              onClick={onCancel}
              className="px-2 py-1 text-xs text-mail-text-muted hover:text-mail-danger
                         hover:bg-mail-border rounded transition-colors"
            >
              Cancel
            </button>
          ) : null}
        </div>

        {/* Progress */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-mail-text-muted">
              {completed} of {total} emails
            </span>
            <span className="text-sm font-medium text-mail-accent">
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
