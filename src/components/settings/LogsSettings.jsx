import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import {
  ScrollText,
  RefreshCw,
  Check,
  Trash2,
  Download,
  Copy,
  Loader,
} from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';
import { SettingsPageLayout } from '../ui/SettingsForm';
import { useSettingsStore } from '../../stores/settingsStore';
import { daemonCall } from '../../services/daemonClient';

const VERBOSITY_LEVELS = ['standard', 'verbose'];

export function LogsSettings() {
  const t = useT();
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const logVerbosity = useSettingsStore(s => s.logVerbosity) || 'standard';
  const setLogVerbosity = useSettingsStore(s => s.setLogVerbosity);

  const invoke = window.__TAURI__?.core?.invoke;

  // Persists locally (relayed to the main window when this runs detached,
  // same as every other settings toggle) and applies to the running daemon
  // right away, without a restart.
  const changeVerbosity = (verbosity) => {
    setLogVerbosity(verbosity);
    daemonCall('logs.set_verbosity', { verbosity }).catch(error => {
      console.error('Failed to set log verbosity:', error);
    });
  };

  const loadLogs = async () => {
    if (!invoke) return;
    setLoadingLogs(true);
    try {
      const logContent = await invoke('read_logs', { lines: 500 });
      setLogs(logContent);
    } catch (error) {
      console.error('Failed to load logs:', error);
      setLogs('Failed to load logs: ' + error);
    } finally {
      setLoadingLogs(false);
    }
  };

  // Load logs on mount
  useEffect(() => {
    if (invoke) {
      loadLogs();
    }
  }, []);

  return (
    <SettingsPageLayout className="h-full flex flex-col">
      <div className="settings-section mb-4" data-testid="log-verbosity">
        <h4 className="font-semibold text-mail-text mb-1">{t('settings.logs.verbosityTitle')}</h4>
        <p className="text-sm text-mail-text-muted mb-3">{t('settings.logs.verbosityDescription')}</p>
        <div role="radiogroup" aria-label={t('settings.logs.verbosityTitle')} className="flex gap-2 flex-wrap">
          {VERBOSITY_LEVELS.map(level => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={logVerbosity === level}
              data-testid={`log-verbosity-${level}`}
              onClick={() => changeVerbosity(level)}
              className={`px-4 py-2 rounded-lg border text-sm transition-colors ${logVerbosity === level
                ? 'border-mail-accent bg-mail-accent/10 text-mail-text font-medium'
                : 'border-mail-border text-mail-text hover:bg-mail-surface-hover'}`}
            >
              {t(`settings.logs.verbosity.${level}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section flex-1 flex flex-col min-h-0">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h4 className="font-semibold text-mail-text flex items-center gap-2">
            <ScrollText size={18} className="text-mail-accent-text" />
            {t('settings.logs.applicationLogs')}
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={loadLogs}
              disabled={loadingLogs || !invoke}
              className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                        hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2"
            >
              <RefreshCw size={14} className={loadingLogs ? 'animate-spin' : ''} />
              {t('settings.logs.refresh')}
            </button>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(logs);
                  setLogsCopied(true);
                  setTimeout(() => setLogsCopied(false), 2000);
                } catch (err) {
                  console.error('Failed to copy logs:', err);
                }
              }}
              disabled={!logs || loadingLogs}
            >
              {logsCopied ? <Check size={14} /> : <Copy size={14} />}
              {logsCopied ? t('settings.logs.copied') : t('viewer.copy')}
            </Button>
            <Button variant="ghost" size="sm" className="hover:bg-mail-border"
              onClick={async () => {
                console.log('Export button clicked, logs length:', logs?.length);
                if (!logs || logs.length === 0) {
                  alert(t('settings.logs.nothingExportYetRefreshLog'));
                  return;
                }
                try {
                  // Use Tauri save dialog if available
                  if (invoke) {
                    const { save } = await import('@tauri-apps/plugin-dialog');
                    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const filePath = await save({
                      defaultPath: `mailvault-logs-${new Date().toISOString().split('T')[0]}.txt`,
                      filters: [{ name: t('settings.logs.textFiles'), extensions: ['txt'] }]
                    });
                    if (filePath) {
                      await writeTextFile(filePath, logs);
                      alert(t('settings.logs.logSaved'));
                    }
                  } else {
                    // Fallback to browser download
                    const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    a.download = `mailvault-logs-${new Date().toISOString().split('T')[0]}.txt`;
                    document.body.appendChild(a);
                    a.click();
                    // Cleanup after a short delay
                    setTimeout(() => {
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }, 100);
                  }
                  console.log('Logs exported successfully');
                } catch (error) {
                  console.error('Failed to export logs:', error);
                  alert(t('settings.logs.couldSaveLogFilePick') + (error.message || error));
                }
              }}
              disabled={!logs || loadingLogs}
            >
              <Download size={14} />
              {t('common.export')}
            </Button>
            <button
              onClick={async () => {
                console.log('Clear button clicked, invoke available:', !!invoke);
                if (!invoke) {
                  alert(t('settings.logs.clearingLogOnlyAvailableDesktop'));
                  return;
                }
                try {
                  const { ask } = await import('@tauri-apps/plugin-dialog');
                  const confirmed = await ask(
                    'Deletes the diagnostic log this app keeps on your computer. Your mail and your vault are not touched.',
                    { title: t('settings.logs.clearLog'), kind: 'warning', okLabel: t('settings.logs.clearLog2'), cancelLabel: t('settings.logs.keep') },
                  );
                  if (!confirmed) return;
                } catch {
                  if (!confirm(t('settings.logs.deleteDiagnosticLogAppKeeps'))) return;
                }
                try {
                  setLoadingLogs(true);
                  console.log('Calling clear_logs...');
                  const result = await invoke('clear_logs');
                  console.log('clear_logs result:', result);
                  // Reload logs after clearing
                  await loadLogs();
                  alert(result || 'Log cleared.');
                } catch (error) {
                  console.error('Failed to clear logs:', error);
                  const errorMsg = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
                  alert(t('settings.logs.failedClearLogs') + errorMsg);
                  // Still try to reload logs
                  await loadLogs();
                } finally {
                  setLoadingLogs(false);
                }
              }}
              disabled={loadingLogs || !invoke}
              className="px-3 py-1.5 text-sm text-mail-danger hover:text-mail-danger
                        hover:bg-mail-danger/10 rounded-lg transition-colors flex items-center gap-2"
            >
              <Trash2 size={14} />
              {t('common.clear')}
            </button>
          </div>
        </div>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.logs.viewRecentApplicationLogsLast')}
        </p>

        <div className="flex-1 min-h-0 overflow-hidden">
          {loadingLogs ? (
            <div className="flex items-center justify-center h-full">
              <Loader size={24} className="animate-spin text-mail-accent-text" />
            </div>
          ) : !invoke ? (
            <div className="flex items-center justify-center h-full text-mail-text-muted">
              <p>{t('settings.logs.logsOnlyAvailableDesktopApp')}</p>
            </div>
          ) : (
            <pre className="h-full overflow-auto bg-mail-bg p-4 rounded-lg text-xs
                           font-mono text-mail-text-muted whitespace-pre-wrap break-words">
              {logs || 'No logs available'}
            </pre>
          )}
        </div>
      </div>
    </SettingsPageLayout>
  );
}
