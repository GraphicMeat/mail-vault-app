import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

export function LinkAlertIcon({ level, size = 14, alerts }) {
  const [showModal, setShowModal] = useState(false);
  if (!level) return null;

  const isRed = level === 'red';
  const title = isRed ? 'Dangerous links detected' : 'Suspicious links detected';

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className={`flex-shrink-0 ${isRed ? 'text-red-500' : 'text-amber-500'} hover:opacity-80 transition-opacity`}
        title={title}
      >
        <AlertTriangle size={size} />
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
                <AlertTriangle size={22} className={isRed ? 'text-red-500' : 'text-amber-500'} />
              </div>
              <h3 className={`text-lg font-bold ${isRed ? 'text-red-500' : 'text-amber-500'}`}>{title}</h3>
            </div>

            {alerts && alerts.length > 0 ? (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                {alerts.map((alert, i) => (
                  <div key={i} className="p-3 rounded-lg bg-mail-surface border border-mail-border">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle size={12} className={alert.level === 'red' ? 'text-red-500' : 'text-amber-500'} />
                      <span className={`text-xs font-medium ${alert.level === 'red' ? 'text-red-500' : 'text-amber-500'}`}>
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
          </div>
        </div>
      )}
    </>
  );
}
