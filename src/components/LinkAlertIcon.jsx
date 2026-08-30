import React, { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { t, useT  } from '../i18n/index.js';

export function LinkAlertIcon({ level, size = 14, alerts }) {
  const t = useT();
  const [showModal, setShowModal] = useState(false);

  const closeModal = useCallback(() => setShowModal(false), []);

  if (!level) return null;

  const isRed = level === 'red';
  const title = isRed ? t('alert.link.dangerousLinksDetected') : t('alert.link.suspiciousLinksDetected');

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className={`flex-shrink-0 ${isRed ? 'text-mail-danger' : 'text-mail-warning'} hover:opacity-80 transition-opacity`}
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
          <div className={`w-10 h-10 rounded-full ${isRed ? 'bg-mail-danger-tint' : 'bg-mail-warning-tint'} flex items-center justify-center`}>
            <AlertTriangle size={22} className={isRed ? 'text-mail-danger' : 'text-mail-warning'} />
          </div>
        }
      >
        {alerts && alerts.length > 0 ? (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {alerts.map((alert, i) => (
              <div key={i} className="p-3 rounded-lg bg-mail-surface border border-mail-border">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={12} className={alert.level === 'red' ? 'text-mail-danger' : 'text-mail-warning'} />
                  <span className={`text-xs font-medium ${alert.level === 'red' ? 'text-mail-danger' : 'text-mail-warning'}`}>
                    {alert.level === 'red' ? t('alert.link.dangerous') : t('alert.link.suspicious')}
                  </span>
                </div>
                <div className="text-xs text-mail-text-muted mb-1">{t('alert.link.linkTextSays')}</div>
                <div className="text-sm font-mono text-mail-text break-all mb-2">{alert.textContent || '(no text)'}</div>
                <div className="text-xs text-mail-text-muted mb-1">{t('alert.link.actuallyGoes')}</div>
                <div className="text-sm font-mono text-mail-text break-all">{alert.actualUrl}</div>
                <div className="text-xs text-mail-text-muted mt-1">{alert.reason}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-mail-text-muted">
            {t('alert.link.emailContainsMismatchedLinks')}
          </p>
        )}
      </Dialog>
    </>
  );
}
