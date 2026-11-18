// Settings > Diagnostics > Logs as a view: the log detail level (Standard masks email addresses in
// the file, Verbose keeps them for a support session) and the app's log with Refresh, Copy,
// Export (where the app can save a file: `exportAction`) and Clear.
// - `level`, `onLevel(level)`; `notes`: lines under the level (a refused write).
// - `text`: the log (`emptyText` when there is none); `loading` (a spinner instead), `unavailable`
//   (no log here).
// - `onRefresh`, `onCopy` (`copied` for two seconds after), `onClear` (`clearLabel`: its accessible
//   name, the button's text by default); `busy` holds them all;
//   `confirm`: a node under the actions (the phone asks there before clearing); `problem` too.
import React from 'react';
import { ScrollText, RefreshCw, Check, Trash2, Copy, Loader } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPageLayout } from '../../ui/SettingsForm';
import { useT } from './viewContext';

const VERBOSITY_LEVELS = ['standard', 'verbose'];
// Literal keys, so the catalog tests can see every one.
const LEVEL_KEYS = Object.freeze({ standard: 'settings.logs.verbosity.standard', verbose: 'settings.logs.verbosity.verbose' });

export function LogsView({
  level, onLevel, notes = null, text, emptyText, loading = false, unavailable = false, busy = false,
  onRefresh, refreshDisabled = false, onCopy, copied = false, exportAction = null, onClear, clearDisabled = false, clearLabel = null,
  confirm = null, problem = null,
}) {
  const t = useT();
  return (
    <SettingsPageLayout className="h-full flex flex-col">
      <div className="settings-section mb-4" data-testid="log-verbosity">
        <h4 className="font-semibold text-mail-text mb-1">{t('settings.logs.verbosityTitle')}</h4>
        <p className="text-sm text-mail-text-muted mb-3">{t('settings.logs.verbosityDescription')}</p>
        <div role="radiogroup" aria-label={t('settings.logs.verbosityTitle')} className="flex gap-2 flex-wrap">
          {VERBOSITY_LEVELS.map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={level === value}
              data-testid={`log-verbosity-${value}`}
              onClick={() => onLevel(value)}
              className={`px-4 py-2 rounded-lg border text-sm transition-colors ${level === value
                ? 'border-mail-accent bg-mail-accent/10 text-mail-text font-medium'
                : 'border-mail-border text-mail-text hover:bg-mail-surface-hover'}`}
            >
              {t(LEVEL_KEYS[value])}
            </button>
          ))}
        </div>
        {notes}
      </div>

      <div className="settings-section flex-1 flex flex-col min-h-0">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h4 className="font-semibold text-mail-text flex items-center gap-2">
            <ScrollText size={18} className="text-mail-accent-text" />
            {t('settings.logs.applicationLogs')}
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={busy || refreshDisabled}
              className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                        hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2"
            >
              <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
              {t('settings.logs.refresh')}
            </button>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={onCopy}
              disabled={!text || busy}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('settings.logs.copied') : t('viewer.copy')}
            </Button>
            {exportAction}
            <button
              onClick={onClear}
              disabled={busy || clearDisabled}
              aria-label={clearLabel || undefined}
              className="px-3 py-1.5 text-sm text-mail-danger hover:text-mail-danger
                        hover:bg-mail-danger/10 rounded-lg transition-colors flex items-center gap-2"
            >
              <Trash2 size={14} />
              {t('common.clear')}
            </button>
          </div>
        </div>
        {confirm}
        {problem}

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.logs.viewRecentApplicationLogsLast')}
        </p>

        <div className="flex-1 min-h-0 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader size={24} className="animate-spin text-mail-accent-text" />
            </div>
          ) : unavailable ? (
            <div className="flex items-center justify-center h-full text-mail-text-muted">
              <p>{t('settings.logs.logsOnlyAvailableDesktopApp')}</p>
            </div>
          ) : (
            <pre className="h-full overflow-auto bg-mail-bg p-4 rounded-lg text-xs
                           font-mono text-mail-text-muted whitespace-pre-wrap break-words">
              {text || emptyText}
            </pre>
          )}
        </div>
      </div>
    </SettingsPageLayout>
  );
}
