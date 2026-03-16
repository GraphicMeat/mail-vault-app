import React, { useState } from 'react';
import { AlertTriangle, X, ShieldAlert } from 'lucide-react';

export function SenderAlertIcon({ level, email, size = 14 }) {
  const [showModal, setShowModal] = useState(false);
  if (!level) return null;

  const isRed = level === 'red';
  const title = isRed ? 'Sender impersonation detected' : 'Suspicious sender name';

  const fromName = email?.from?.name || '';
  const fromAddress = email?.from?.address || '';

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className={`flex-shrink-0 ${isRed ? 'text-red-500' : 'text-amber-500'} hover:opacity-80 transition-opacity`}
        title={title}
      >
        <ShieldAlert size={size} />
      </button>
      {showModal && (
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
              <div className={`w-10 h-10 rounded-full ${isRed ? 'bg-red-500/20' : 'bg-amber-500/20'} flex items-center justify-center`}>
                <ShieldAlert size={22} className={isRed ? 'text-red-500' : 'text-amber-500'} />
              </div>
              <h3 className={`text-lg font-bold ${isRed ? 'text-red-500' : 'text-amber-500'}`}>{title}</h3>
            </div>

            <p className="text-sm text-mail-text-muted mb-4">
              {isRed
                ? 'The sender\'s display name shows a different email address than the actual sender. This is a common phishing technique to impersonate trusted contacts.'
                : 'The sender\'s display name looks like a domain that doesn\'t match the actual sender domain. This could indicate impersonation.'}
            </p>

            <div className="mb-3 p-3 rounded-lg bg-mail-surface border border-mail-border">
              <div className="text-xs text-mail-text-muted mb-1">Display name shows:</div>
              <div className="text-sm font-mono text-mail-text break-all">{fromName}</div>
            </div>

            <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
              <div className="text-xs text-mail-text-muted mb-1">Actual sender address:</div>
              <div className="text-sm font-mono text-mail-text break-all">{fromAddress}</div>
              {fromAddress.includes('@') && (
                <div className={`text-xs ${isRed ? 'text-red-500' : 'text-amber-500'} mt-0.5`}>
                  {fromAddress.split('@')[1]}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Get the highest sender alert level from an array of emails.
 */
export function getSenderAlertLevel(emails) {
  if (!emails || emails.length === 0) return null;
  let max = null;
  let alertEmail = null;
  for (const e of emails) {
    if (e._senderAlert === 'red') return { level: 'red', email: e };
    if (e._senderAlert === 'yellow') { max = 'yellow'; alertEmail = e; }
  }
  return max ? { level: max, email: alertEmail } : null;
}
