import React, { useEffect } from 'react';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';

export function LinkSafetyModal({ alert, onOpenAnyway, onCancel }) {
  useEffect(() => {
    if (!alert) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [alert, onCancel]);

  if (!alert) return null;

  const isRed = alert.level === 'red';
  const bgColor = 'bg-mail-bg';
  const borderColor = isRed ? 'border-mail-danger' : 'border-mail-warning';
  const iconColor = isRed ? 'text-mail-danger' : 'text-mail-warning';
  const title = isRed ? 'Dangerous Link Detected' : 'Suspicious Link Detected';

  let textDomain = '';
  let actualDomain = '';
  try {
    const text = alert.textContent || '';
    if (text.includes('://') || text.startsWith('www.')) {
      textDomain = new URL(text.startsWith('www.') ? `https://${text}` : text).hostname;
    }
    actualDomain = new URL(alert.actualUrl).hostname;
  } catch { /* ignore */ }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className={`relative max-w-md w-full ${bgColor} border ${borderColor} rounded-2xl shadow-2xl p-6`}
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onCancel} className="absolute top-4 right-4 p-1 rounded-lg hover:bg-mail-surface-hover">
          <X size={18} className="text-mail-text-muted" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full ${isRed ? 'bg-mail-danger-tint' : 'bg-mail-warning-tint'} flex items-center justify-center`}>
            <AlertTriangle size={22} className={iconColor} />
          </div>
          <h3 className={`text-lg font-bold ${isRed ? 'text-mail-danger' : 'text-mail-warning'}`}>{title}</h3>
        </div>

        <p className="text-sm text-mail-text-muted mb-4">{alert.reason}</p>

        <div className="mb-3 p-3 rounded-lg bg-mail-surface border border-mail-border">
          <div className="text-xs text-mail-text-muted mb-1">Link text says:</div>
          <div className="text-sm font-mono text-mail-text break-all">{alert.textContent || '(no text)'}</div>
          {textDomain && <div className="text-xs text-mail-success mt-0.5">{textDomain}</div>}
        </div>

        <div className="mb-5 p-3 rounded-lg bg-mail-surface border border-mail-border">
          <div className="text-xs text-mail-text-muted mb-1">Actually redirects to:</div>
          <div className="text-sm font-mono text-mail-text break-all">{alert.actualUrl}</div>
          {actualDomain && <div className={`text-xs ${isRed ? 'text-mail-danger' : 'text-mail-warning'} mt-0.5`}>{actualDomain}</div>}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-lg bg-mail-surface border border-mail-border text-mail-text font-medium hover:bg-mail-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onOpenAnyway}
            className={`flex-1 px-4 py-2.5 rounded-lg font-medium transition-colors flex items-center justify-center gap-2
                       ${isRed ? 'bg-mail-danger-tint border border-mail-danger/30 text-mail-danger hover:bg-mail-danger/20'
                               : 'bg-mail-warning-tint border border-mail-warning/30 text-mail-warning hover:bg-mail-warning/20'}`}
          >
            <ExternalLink size={14} />
            Open Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
