import React, { useCallback, useState } from 'react';
import { AlertTriangle, CornerUpLeft } from 'lucide-react';
import { Dialog } from './ui/Dialog';

/**
 * Warning icon shown next to a subject when the email's Reply-To address
 * points to a different domain than the From address. Common phishing signal.
 *
 * `mismatch` has the shape: { fromDomain, replyToAddress, replyToDomain }.
 * Renders nothing when mismatch is falsy, so callers can pass the raw flag.
 */
/**
 * Return the first reply-to mismatch found across a thread's emails, or null.
 * Used by thread rows to surface the warning on the topic line.
 */
export function getThreadReplyToMismatch(emails) {
  if (!emails || emails.length === 0) return null;
  for (const e of emails) {
    if (e._replyToMismatch) return e._replyToMismatch;
  }
  return null;
}

export function ReplyToAlertIcon({ mismatch, size = 14 }) {
  const [showModal, setShowModal] = useState(false);

  const closeModal = useCallback(() => setShowModal(false), []);

  if (!mismatch) return null;

  const title = 'Reply-To domain mismatch';

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className="flex-shrink-0 text-mail-warning hover:opacity-80 transition-opacity"
        aria-label={title}
        title={title}
      >
        <AlertTriangle size={size} />
      </button>
      <Dialog
        open={showModal}
        onClose={closeModal}
        role="alertdialog"
        // Portal to body: virtualized list cells sit under an ancestor with a
        // `transform`, which becomes the containing block for `position: fixed`
        // and would clip this to the row.
        portal
        title={title}
        icon={
          <div className="w-10 h-10 rounded-full bg-mail-warning-tint flex items-center justify-center">
            <CornerUpLeft size={22} className="text-mail-warning" />
          </div>
        }
      >
        <p className="text-sm text-mail-text-muted">
          Replies to this message would go to a different domain than the sender. Legitimate senders usually route replies to the same domain they send from — a mismatch is a common phishing indicator.
        </p>

        <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
          <div className="text-xs text-mail-text-muted mb-1">Sent from domain:</div>
          <div className="text-sm font-mono text-mail-text break-all">{mismatch.fromDomain}</div>
        </div>

        <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
          <div className="text-xs text-mail-text-muted mb-1">Replies would go to:</div>
          <div className="text-sm font-mono text-mail-text break-all">{mismatch.replyToAddress || mismatch.replyToDomain}</div>
          <div className="text-xs text-mail-warning mt-0.5">{mismatch.replyToDomain}</div>
        </div>
      </Dialog>
    </>
  );
}
