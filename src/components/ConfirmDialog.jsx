import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertTriangle, Loader } from 'lucide-react';

/**
 * Reusable in-app confirmation dialog.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {Function} props.onClose - called on backdrop click, X button, or Cancel
 * @param {Function} props.onConfirm - called when the primary action is clicked
 * @param {string} props.title
 * @param {string|React.ReactNode} props.description
 * @param {string} [props.confirmLabel='Confirm'] - primary action button text
 * @param {string} [props.cancelLabel='Cancel']
 * @param {boolean} [props.destructive=false] - if true, primary button is red
 * @param {boolean} [props.loading=false] - shows spinner and disables buttons
 * @param {React.ReactNode} [props.icon] - custom icon element for the header
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  icon,
}) {
  if (!isOpen) return null;

  const confirmColors = destructive
    ? 'bg-red-500 hover:bg-red-600 text-white'
    : 'bg-mail-accent hover:bg-mail-accent/90 text-white';

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative max-w-md w-full bg-mail-bg border border-mail-border rounded-2xl shadow-2xl p-6"
          onClick={e => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            disabled={loading}
            className="absolute top-4 right-4 p-1 rounded-lg hover:bg-mail-surface-hover transition-colors disabled:opacity-50"
          >
            <X size={18} className="text-mail-text-muted" />
          </button>

          {/* Icon + Title */}
          <div className="flex items-center gap-3 mb-4">
            {icon || (
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${destructive ? 'bg-red-500/10' : 'bg-mail-accent/10'}`}>
                <AlertTriangle size={20} className={destructive ? 'text-red-500' : 'text-mail-accent'} />
              </div>
            )}
            <h3 className="text-lg font-semibold text-mail-text pr-8">{title}</h3>
          </div>

          {/* Description */}
          {description && (
            <div className="text-sm text-mail-text-muted mb-6">
              {typeof description === 'string' ? <p>{description}</p> : description}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2.5 rounded-lg bg-mail-surface border border-mail-border
                         text-mail-text font-medium hover:bg-mail-surface-hover transition-colors
                         disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className={`flex-1 px-4 py-2.5 rounded-lg font-medium transition-colors
                         disabled:opacity-50 flex items-center justify-center gap-2 ${confirmColors}`}
            >
              {loading && <Loader size={14} className="animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
