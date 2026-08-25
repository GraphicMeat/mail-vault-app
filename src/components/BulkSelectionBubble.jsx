import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ListChecks } from 'lucide-react';
import { useMailStore } from '../stores/mailStore';
import { decodeImapUtf7 } from '../utils/imapUtf7';

/**
 * Minimized bulk-operations session.
 *
 * The bulk modal's selection is real list selection, so closing the modal must
 * not throw it away. This chip is where a minimized session lives: it names the
 * account and folder the session belongs to, counts the live selection (so a
 * checkbox toggled by hand moves the number), and reopens the modal at the step
 * it was left on.
 *
 * Named/foldered from the session's own bound (accountId, mailbox) — not the
 * currently-active ones. They're equal whenever this is visible (EmailList
 * ends the session the moment the user navigates away from that triple), but
 * the bound values are what the session actually means and won't lie if that
 * invariant ever changes.
 *
 * Sits above SelectionActionBar — both are visible, and both act on the same
 * `selectedEmailIds`, so there is nothing for them to disagree about.
 */
export function BulkSelectionBubble() {
  const bulkSession = useMailStore(s => s.bulkSession);
  const bulkModalOpen = useMailStore(s => s.bulkModalOpen);
  const selectedEmailIds = useMailStore(s => s.selectedEmailIds);
  const accounts = useMailStore(s => s.accounts);
  const openBulkModal = useMailStore(s => s.openBulkModal);
  const endBulkSession = useMailStore(s => s.endBulkSession);

  const visible = !!bulkSession?.active && !bulkModalOpen;
  const email = accounts.find(a => a.id === bulkSession?.accountId)?.email || '';
  const folder = bulkSession?.mailbox === 'UNIFIED' ? 'All inboxes' : bulkSession?.mailbox;
  const count = selectedEmailIds.size;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="bulk-bubble"
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-20 sm:bottom-24 z-40 flex justify-center px-3 pointer-events-none"
        >
          <div
            className="flex items-center gap-2 pl-3 pr-1 py-1.5 bg-mail-surface border border-mail-accent/40
                       rounded-xl shadow-2xl backdrop-blur-sm pointer-events-auto"
            data-testid="bulk-selection-bubble"
          >
            <button
              onClick={openBulkModal}
              data-testid="bulk-selection-bubble-reopen"
              className="flex items-center gap-2 px-1 py-0.5 rounded-lg hover:bg-mail-surface-hover transition-colors"
              title="Back to bulk operations"
            >
              <ListChecks size={15} className="text-mail-accent flex-shrink-0" />
              <span className="text-sm text-mail-text whitespace-nowrap">
                <span className="text-mail-text-muted">{email}</span>
                <span className="text-mail-text-muted mx-1.5">·</span>
                <span className="text-mail-text-muted">{decodeImapUtf7(folder)}</span>
                <span className="text-mail-text-muted mx-1.5">·</span>
                <span className="font-medium">{count.toLocaleString()} selected</span>
              </span>
            </button>
            <button
              onClick={endBulkSession}
              className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-colors"
              title="End bulk selection"
            >
              <X size={14} className="text-mail-text-muted" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
