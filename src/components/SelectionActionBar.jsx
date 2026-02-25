import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMailStore } from '../stores/mailStore';
import {
  MailOpen, Mail, Trash2, Archive, X, AlertTriangle
} from 'lucide-react';
import { useState } from 'react';

export function SelectionActionBar() {
  const selectedEmailIds = useMailStore(s => s.selectedEmailIds);
  const clearSelection = useMailStore(s => s.clearSelection);
  const saveSelectedLocally = useMailStore(s => s.saveSelectedLocally);
  const markSelectedAsRead = useMailStore(s => s.markSelectedAsRead);
  const markSelectedAsUnread = useMailStore(s => s.markSelectedAsUnread);
  const deleteSelectedFromServer = useMailStore(s => s.deleteSelectedFromServer);
  const getSelectionSummary = useMailStore(s => s.getSelectionSummary);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const hasSelection = selectedEmailIds.size > 0;
  const summary = useMemo(() => {
    if (!hasSelection) return { threads: 0, emails: 0 };
    return getSelectionSummary();
  }, [hasSelection, selectedEmailIds, getSelectionSummary]);

  // Fire-and-forget: actions clear selection internally via the store.
  // No actionInProgress gating — archive/mark ops are long-running and
  // have their own progress indicators (BulkSaveProgress bar).
  const handleAction = (action) => {
    action();
  };

  const handleDelete = () => {
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    setShowDeleteConfirm(false);
    deleteSelectedFromServer();
  };

  const selectionLabel = summary.threads === summary.emails
    ? `${summary.threads} selected`
    : `${summary.threads} selected (${summary.emails} emails)`;

  return (
    <AnimatePresence>
      {hasSelection && (
        <motion.div
          key="selection-bar"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 bg-mail-surface border border-mail-border
                         rounded-xl shadow-2xl backdrop-blur-sm">
            {/* Selection count */}
            <span className="text-sm font-medium text-mail-text px-3 whitespace-nowrap">
              {selectionLabel}
            </span>

            <div className="w-px h-6 bg-mail-border" />

            {/* Actions */}
            <button
              onClick={() => handleAction(markSelectedAsRead)}
              className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
              title="Mark as read"
            >
              <MailOpen size={16} className="text-mail-text-muted" />
            </button>
            <button
              onClick={() => handleAction(markSelectedAsUnread)}
              className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
              title="Mark as unread"
            >
              <Mail size={16} className="text-mail-text-muted" />
            </button>

            <div className="w-px h-6 bg-mail-border" />

            <button
              onClick={() => handleAction(saveSelectedLocally)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-local"
              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-local) 10%, transparent)'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
              title="Archive selected"
            >
              <Archive size={15} />
              <span className="text-xs font-medium">Archive</span>
            </button>
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-danger"
              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-danger) 10%, transparent)'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
              title="Delete from server"
            >
              <Trash2 size={15} />
              <span className="text-xs font-medium">Delete</span>
            </button>

            <div className="w-px h-6 bg-mail-border" />

            {/* Clear */}
            <button
              onClick={clearSelection}
              className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
              title="Clear selection"
            >
              <X size={16} className="text-mail-text-muted" />
            </button>
          </div>

          {/* Delete confirmation popover */}
          <AnimatePresence>
            {showDeleteConfirm && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-mail-bg border border-mail-border
                          rounded-xl shadow-2xl p-4 min-w-[280px]"
              >
                <div className="flex items-start gap-2 mb-3">
                  <AlertTriangle size={16} className="text-mail-danger flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-mail-text">
                    Delete {summary.emails} email{summary.emails !== 1 ? 's' : ''} from server? This cannot be undone.
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 text-xs text-mail-text-muted hover:bg-mail-border rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDelete}
                    className="px-3 py-1.5 text-xs font-medium bg-mail-danger text-white rounded-lg
                              hover:bg-mail-danger/90 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
