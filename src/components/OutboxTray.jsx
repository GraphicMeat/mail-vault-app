import React from 'react';
import { useComposeStore } from '../stores/composeStore';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader, Check, AlertTriangle, RefreshCw, X } from 'lucide-react';

// Renders one bubble per in-flight or errored send. Mirrors the minimized
// compose bubble style so the compose → send → success/error flow all lives
// on the same visual surface. Successes auto-dismiss; errors stay until the
// user retries or dismisses (which restores the compose window).
export function OutboxTray({ onRestoreDraft }) {
  const items = useComposeStore(s => s.outboxItems);
  const retryOutbox = useComposeStore(s => s.retryOutbox);
  const dismissOutbox = useComposeStore(s => s.dismissOutbox);
  const cancelOutbox = useComposeStore(s => s.cancelOutbox);

  if (!items || items.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-4 z-[60] flex flex-col gap-2">
      <AnimatePresence>
        {items.map(item => {
          const subject = item.composeState?.initialData?.subject || 'New Message';
          const recipient = item.composeState?.initialData?.to || '';
          const isError = item.status === 'error';
          const isSent = item.status === 'sent';
          const isSending = item.status === 'sending';

          return (
            <motion.div
              key={item.id}
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-2xl min-w-[320px] max-w-[420px] border
                         ${isError
                           ? 'bg-red-500/10 border-red-500/40'
                           : 'bg-mail-surface border-mail-border'}`}
              data-testid={`outbox-bubble-${item.status}`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
                              ${isError ? 'bg-red-500/20'
                               : isSent ? 'bg-green-500/20'
                               : 'bg-mail-accent/20'}`}>
                {isSending && <Loader size={14} className="text-mail-accent animate-spin" />}
                {isSent && <Check size={14} className="text-green-500" />}
                {isError && <AlertTriangle size={14} className="text-red-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-mail-text truncate">{subject}</p>
                {recipient && (
                  <p className="text-[10px] text-mail-text-muted truncate">To: {recipient}</p>
                )}
                <p className={`text-[11px] mt-0.5 ${isError ? 'text-red-400' : 'text-mail-text-muted'}`}>
                  {isSending && 'Sending…'}
                  {isSent && 'Sent'}
                  {isError && (item.error || 'Failed to send')}
                </p>
              </div>
              {isSending && (
                <button
                  onClick={() => {
                    cancelOutbox(item.id);
                    if (onRestoreDraft && item.composeState) onRestoreDraft(item.composeState);
                  }}
                  className="flex-shrink-0 p-1 rounded-md text-mail-text-muted
                             hover:bg-mail-surface-hover hover:text-mail-text transition-colors"
                  title="Cancel send and restore draft"
                  aria-label="Cancel send"
                >
                  <X size={14} />
                </button>
              )}
              {isError && (
                <div className="flex flex-col gap-1 flex-shrink-0">
                  <button
                    onClick={() => retryOutbox(item.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium
                               text-mail-accent hover:bg-mail-surface-hover rounded-md transition-colors"
                    title="Retry send"
                  >
                    <RefreshCw size={12} />
                    Retry
                  </button>
                  <button
                    onClick={() => {
                      dismissOutbox(item.id);
                      if (onRestoreDraft && item.composeState) onRestoreDraft(item.composeState);
                    }}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium
                               text-mail-text-muted hover:bg-mail-surface-hover rounded-md transition-colors"
                    title="Dismiss and restore draft"
                  >
                    <X size={12} />
                    Edit
                  </button>
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
