import React, { useCallback, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { t, useT  } from '../i18n/index.js';

export function SenderAlertIcon({ level, email, size = 14 }) {
  const t = useT();
  const [showModal, setShowModal] = useState(false);

  const closeModal = useCallback(() => setShowModal(false), []);

  if (!level) return null;

  const isRed = level === 'red';
  const title = isRed ? t('alert.sender.senderImpersonationDetected') : t('alert.sender.suspiciousSenderName');

  const fromName = email?.from?.name || '';
  const fromAddress = email?.from?.address || '';

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className={`flex-shrink-0 ${isRed ? 'text-mail-danger' : 'text-mail-warning'} hover:opacity-80 transition-opacity`}
        aria-label={title}
        title={title}
      >
        <ShieldAlert size={size} />
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
          <div className={`w-10 h-10 rounded-full ${isRed ? 'bg-mail-danger-tint' : 'bg-mail-warning-tint'} flex items-center justify-center`}>
            <ShieldAlert size={22} className={isRed ? 'text-mail-danger' : 'text-mail-warning'} />
          </div>
        }
      >
        <p className="text-sm text-mail-text-muted">
          {isRed
            ? t('alert.sender.senderSDisplayNameShows')
            : t('alert.sender.senderSDisplayNameLooks')}
        </p>

        <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
          <div className="text-xs text-mail-text-muted mb-1">{t('alert.sender.displayNameShows')}</div>
          <div className="text-sm font-mono text-mail-text break-all">{fromName}</div>
        </div>

        <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
          <div className="text-xs text-mail-text-muted mb-1">{t('alert.sender.actualSenderAddress')}</div>
          <div className="text-sm font-mono text-mail-text break-all">{fromAddress}</div>
          {fromAddress.includes('@') && (
            <div className={`text-xs ${isRed ? 'text-mail-danger' : 'text-mail-warning'} mt-0.5`}>
              {fromAddress.split('@')[1]}
            </div>
          )}
        </div>
      </Dialog>
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
