import React, { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from './ui/Dialog';

export function LinkAlertIcon({ level, size = 14, alerts }) {
  const [showModal, setShowModal] = useState(false);

  const closeModal = useCallback(() => setShowModal(false), []);

  if (!level) return null;

  const isRed = level === 'red';
  const title = isRed ? 'Dangerous links detected' : 'Suspicious links detected';

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
                    {alert.level === 'red' ? 'Dangerous' : 'Suspicious'}
                  </span>
                </div>
                <div className="text-xs text-mail-text-muted mb-1">Link text says:</div>
                <div className="text-sm font-mono text-mail-text break-all mb-2">{alert.textContent || '(no text)'}</div>
                <div className="text-xs text-mail-text-muted mb-1">Actually goes to:</div>
                <div className="text-sm font-mono text-mail-text break-all">{alert.actualUrl}</div>
                <div className="text-xs text-mail-text-muted mt-1">{alert.reason}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-mail-text-muted">
            This email contains links where the displayed text doesn't match the actual destination.
            Open the email to see the specific links flagged.
          </p>
        )}
      </Dialog>
    </>
  );
}
