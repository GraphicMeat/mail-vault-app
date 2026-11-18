// Settings > Diagnostics: the server actions MailVault still owes, as a view. Each entry (the app
// maps its own journal into this shape):
//   { id, op ('delete' | 'purge' | 'move' | 'flag' | other), labelKey, total, gone, left, where,
//     tries (number | null), untried, reason (translated text), messages: [{ uid, subject, from,
//     statusKey, tone, title }] | null }
// `onRetry()` (Retry now, `busy` while it runs), `onCancel(entry)` (`cancelDisabled`, `cancelLabel(label)`: its name). `problem`: why the list may be
// incomplete; `loaded`: the list has been read (so an empty one says so).
import React, { forwardRef } from 'react';
import { RefreshCw, Trash2, FolderInput, Flag, Clock, Eraser } from 'lucide-react';
import { useT } from './viewContext';

const OP_ICON = { delete: Trash2, purge: Eraser, move: FolderInput, flag: Flag };

export const PendingActionsView = forwardRef(function PendingActionsView({
  entries, busy = false, onRetry, onCancel, problem = null, loaded = true, cancelLabel = null, cancelDisabled = false,
}, ref) {
  const t = useT();
  return (
    <div className="settings-section" id="pending-actions" ref={ref}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-mail-text">{t('settings.pendingActions.title')}</h3>
          <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.blurb')}</p>
        </div>
        <button
          onClick={onRetry}
          disabled={busy || entries.length === 0}
          className="text-xs font-medium text-mail-accent-text hover:text-mail-accent/80 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          <RefreshCw size={12} className={`inline mr-1 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          {t('settings.pendingActions.retryNow')}
        </button>
      </div>

      {problem && (
        <p role="status" className="text-xs text-mail-danger mb-2">{problem}</p>
      )}
      {entries.length === 0 ? (
        !problem && loaded && <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map(entry => {
            const Icon = OP_ICON[entry.op] || Clock;
            const label = t(entry.labelKey);
            return (
              <li key={`${entry.op}-${entry.id}`} className="flex items-start gap-3 p-3 rounded-lg bg-mail-surface">
                <Icon size={16} className="mt-0.5 text-mail-text-muted shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-mail-text">
                    {label}
                    {' · '}
                    {t('common.messageCount', { count: entry.total })}
                    {entry.gone > 0 && ` · ${t('settings.pendingActions.progress', { deleted: entry.gone, left: entry.left })}`}
                  </p>
                  <p className="text-xs text-mail-text-muted truncate">
                    {entry.where}
                  </p>
                  {entry.tries > 0 && (
                    <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.attempts', { count: entry.tries })}</p>
                  )}
                  {entry.untried && <p className="text-xs text-mail-text-muted mt-1">{t('settings.pendingActions.notTriedYet')}</p>}
                  {entry.reason && <p className="text-xs text-mail-danger mt-1 break-words">{entry.reason}</p>}
                  {entry.messages && (
                    <details className="mt-1">
                      <summary className="text-xs text-mail-text-muted cursor-pointer select-none">
                        {t('settings.pendingActions.showMessages')}
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {entry.messages.map(m => (
                          <li key={m.uid} className="flex items-baseline gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-mail-text">
                              {m.subject || t('common.noSubject')}
                              {m.from && <span className="text-mail-text-muted"> · {m.from}</span>}
                            </span>
                            <span className={`shrink-0 ${m.tone}`} title={m.title}>
                              {t(m.statusKey)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                <button
                  onClick={() => onCancel(entry)}
                  disabled={cancelDisabled || undefined}
                  aria-label={cancelLabel ? cancelLabel(label) : undefined}
                  className="text-xs font-medium text-mail-danger hover:opacity-80 transition-opacity shrink-0"
                >
                  {t('common.cancel')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
