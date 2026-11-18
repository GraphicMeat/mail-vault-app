import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { Download } from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { LogsView } from './views/LogsView';
import { useSettingsStore } from '../../stores/settingsStore';
import { daemonCall } from '../../services/daemonClient';

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

  const clearLog = async () => {
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
  };

  return (
    <DesktopViewEnv>
    <LogsView level={logVerbosity} onLevel={changeVerbosity} text={logs} emptyText={'No logs available'}
      loading={loadingLogs} unavailable={!invoke} busy={loadingLogs}
      onRefresh={loadLogs} refreshDisabled={!invoke} clearDisabled={!invoke} onClear={clearLog}
      copied={logsCopied}
      onCopy={async () => {
        try {
          await navigator.clipboard.writeText(logs);
          setLogsCopied(true);
          setTimeout(() => setLogsCopied(false), 2000);
        } catch (err) {
          console.error('Failed to copy logs:', err);
        }
      }}
      exportAction={
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
      } />
    </DesktopViewEnv>
  );
}
