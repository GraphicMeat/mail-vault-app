import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X, CornerUpLeft } from 'lucide-react';

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

  useEffect(() => {
    if (!showModal) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setShowModal(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showModal]);

  if (!mismatch) return null;

  const title = 'Reply-To domain mismatch';

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className="flex-shrink-0 text-amber-500 hover:opacity-80 transition-opacity"
        title={title}
      >
        <AlertTriangle size={size} />
      </button>
      {showModal && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative max-w-md w-full bg-mail-bg border border-mail-border rounded-2xl shadow-2xl p-6"
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => setShowModal(false)} className="absolute top-4 right-4 p-1 rounded-lg hover:bg-mail-surface-hover">
              <X size={18} className="text-mail-text-muted" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                <CornerUpLeft size={22} className="text-amber-500" />
              </div>
              <h3 className="text-lg font-bold text-amber-500">{title}</h3>
            </div>

            <p className="text-sm text-mail-text-muted mb-4">
              Replies to this message would go to a different domain than the sender. Legitimate senders usually route replies to the same domain they send from — a mismatch is a common phishing indicator.
            </p>

            <div className="mb-3 p-3 rounded-lg bg-mail-surface border border-mail-border">
              <div className="text-xs text-mail-text-muted mb-1">Sent from domain:</div>
              <div className="text-sm font-mono text-mail-text break-all">{mismatch.fromDomain}</div>
            </div>

            <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
              <div className="text-xs text-mail-text-muted mb-1">Replies would go to:</div>
              <div className="text-sm font-mono text-mail-text break-all">{mismatch.replyToAddress || mismatch.replyToDomain}</div>
              <div className="text-xs text-amber-500 mt-0.5">{mismatch.replyToDomain}</div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
