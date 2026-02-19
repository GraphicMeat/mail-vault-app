import React from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { HardDrive, Check, X, AlertCircle } from 'lucide-react';

export function BulkSaveProgress() {
  const { bulkSaveProgress, dismissBulkProgress, cancelArchive } = useMailStore();
  
  if (!bulkSaveProgress) return null;
  
  const { total, completed, errors, active } = bulkSaveProgress;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isComplete = !active && completed + errors >= total;
  
  return (
    <AnimatePresence>
      <motion.div
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
                  <HardDrive size={14} className="text-mail-accent" />
                </div>
              )}
              <span className="font-medium text-mail-text text-sm">
                {isComplete 
                  ? errors === 0 
                    ? 'Saved Successfully' 
                    : `Saved with ${errors} error(s)`
                  : 'Saving Emails...'}
              </span>
            </div>
            
            {isComplete ? (
              <button
                onClick={dismissBulkProgress}
                className="p-1 hover:bg-mail-border rounded transition-colors"
              >
                <X size={14} className="text-mail-text-muted" />
              </button>
            ) : (
              <button
                onClick={cancelArchive}
                className="px-2 py-1 text-xs text-mail-text-muted hover:text-mail-danger
                           hover:bg-mail-border rounded transition-colors"
              >
                Cancel
              </button>
            )}
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
                {errors} email(s) failed to save
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
