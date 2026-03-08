import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HardDrive, Trash2, Check, AlertCircle, Minimize2, Maximize2, X
} from 'lucide-react';

const PHASE_LABELS = {
  archive: 'Downloading',
  verify: 'Verifying',
  delete: 'Deleting',
};

const PHASE_ICONS = {
  archive: HardDrive,
  verify: Check,
  delete: Trash2,
};

export function BulkOperationProgress({ operation, onCancel, onDismiss }) {
  const [minimized, setMinimized] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const handleDismiss = useCallback(() => {
    if (onDismiss) onDismiss();
  }, [onDismiss]);

  if (!operation) return null;

  const { status, currentPhase, total, completed, errors, type } = operation;
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

  // Determine phase count for display
  const totalPhases = type === 'archive_and_delete' ? 2 : 1;
  const currentPhaseNum = currentPhase === 'delete' && type === 'archive_and_delete' ? 2 : 1;

  const PhaseIcon = PHASE_ICONS[currentPhase] || HardDrive;
  const phaseLabel = PHASE_LABELS[currentPhase] || 'Processing';

  if (!isActive && !isComplete && !isCancelled && !isError) return null;

  // Minimized view
  if (minimized && isActive) {
    return (
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="fixed bottom-4 right-4 z-50"
      >
        <button
          onClick={() => setMinimized(false)}
          className="flex items-center gap-2 px-3 py-2 bg-mail-surface border border-mail-border
                    rounded-lg shadow-lg hover:bg-mail-surface-hover transition-colors"
        >
          <PhaseIcon size={14} className="text-mail-accent animate-pulse" />
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
        <div className="bg-mail-surface border border-mail-border rounded-xl shadow-2xl
                       overflow-hidden min-w-[320px]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
            <div className="flex items-center gap-2">
              {isComplete ? (
                <div className="w-6 h-6 bg-mail-success/20 rounded-full flex items-center justify-center">
                  <Check size={14} className="text-mail-success" />
                </div>
              ) : isError ? (
                <div className="w-6 h-6 bg-mail-danger/20 rounded-full flex items-center justify-center">
                  <AlertCircle size={14} className="text-mail-danger" />
                </div>
              ) : (
                <div className="w-6 h-6 bg-mail-accent/20 rounded-full flex items-center justify-center">
                  <PhaseIcon size={14} className="text-mail-accent" />
                </div>
              )}
              <span className="font-medium text-mail-text text-sm">
                {isComplete
                  ? 'Operation Complete'
                  : isCancelled
                    ? 'Operation Cancelled'
                    : isError
                      ? 'Operation Failed'
                      : totalPhases > 1
                        ? `Phase ${currentPhaseNum}/${totalPhases}: ${phaseLabel}`
                        : phaseLabel}
              </span>
            </div>

            <div className="flex items-center gap-1">
              {isDone ? (
                <button
                  onClick={handleDismiss}
                  className="p-1 hover:bg-mail-border rounded transition-colors"
                >
                  <X size={14} className="text-mail-text-muted" />
                </button>
              ) : isActive ? (
                <>
                  <button
                    onClick={() => setMinimized(true)}
                    className="p-1 hover:bg-mail-border rounded transition-colors"
                    title="Minimize"
                  >
                    <Minimize2 size={14} className="text-mail-text-muted" />
                  </button>
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="px-2 py-1 text-xs text-mail-text-muted hover:text-mail-danger
                             hover:bg-mail-border rounded transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {/* Cancel confirmation */}
          {showCancelConfirm && (
            <div className="px-4 py-3 bg-mail-danger/5 border-b border-mail-border">
              <p className="text-xs text-mail-text mb-2">Cancel operation? Already archived emails will be kept.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="px-3 py-1 text-xs bg-mail-surface border border-mail-border rounded-lg
                            hover:bg-mail-surface-hover transition-colors text-mail-text"
                >
                  Continue
                </button>
                <button
                  onClick={() => { setShowCancelConfirm(false); onCancel(); }}
                  className="px-3 py-1 text-xs bg-mail-danger text-white rounded-lg
                            hover:bg-mail-danger/90 transition-colors"
                >
                  Yes, Stop
                </button>
              </div>
            </div>
          )}

          {/* Progress */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-mail-text-muted">
                {completed.toLocaleString()} of {total.toLocaleString()} emails
              </span>
              <span className="text-sm font-medium text-mail-accent">
                {percentage}%
              </span>
            </div>

            <div className="h-2 bg-mail-border rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${percentage}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className={`h-full rounded-full ${
                  isComplete ? 'bg-mail-success'
                    : isError ? 'bg-mail-danger'
                    : currentPhase === 'delete' ? 'bg-mail-warning'
                    : 'bg-mail-accent'
                }`}
              />
            </div>

            {errors > 0 && (
              <div className="mt-2 text-xs text-mail-danger">
                {errors} email(s) failed
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
