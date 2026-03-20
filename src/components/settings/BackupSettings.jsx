import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';
import { backupScheduler } from '../../services/backupScheduler';
import { ToggleSwitch } from './ToggleSwitch';
import { motion, AnimatePresence } from 'framer-motion';
import { safeStorage } from '../../stores/safeStorage';
import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader,
  Shield,
  Download,
  Upload,
  HardDrive,
  Wrench,
} from 'lucide-react';

function formatRelativeTime(timestamp) {
  if (!timestamp) return '--';
  const diff = Date.now() - timestamp;
  const absDiff = Math.abs(diff);
  const isFuture = diff < 0;

  if (absDiff < 60_000) return isFuture ? 'in < 1 min' : 'just now';
  if (absDiff < 3600_000) {
    const mins = Math.round(absDiff / 60_000);
    return isFuture ? `in ${mins} min` : `${mins} min ago`;
  }
  if (absDiff < 86400_000) {
    const hrs = Math.round(absDiff / 3600_000);
    return isFuture ? `in ${hrs}h` : `${hrs}h ago`;
  }
  const days = Math.round(absDiff / 86400_000);
  return isFuture ? `in ${days}d` : `${days}d ago`;
}

function formatDuration(secs) {
  if (!secs || secs < 1) return '< 1s';
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatSize(bytes) {
  if (bytes == null) return '--';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatTimestamp(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

function AccountCard({ account, isPaidUser, globalEnabled }) {
  const backupSchedules = useSettingsStore(s => s.backupSchedules);
  const backupState = useSettingsStore(s => s.backupState);
  const backupHistory = useSettingsStore(s => s.backupHistory);
  const accountColors = useSettingsStore(s => s.accountColors);
  const setBackupSchedule = useSettingsStore(s => s.setBackupSchedule);

  const config = backupSchedules[account.id] || { enabled: false, interval: 'daily', hourlyInterval: 1, timeOfDay: '03:00', dayOfWeek: 1 };
  const state = backupState[account.id] || {};
  const history = (backupHistory[account.id] || []).slice(0, 5);

  const [runningManual, setRunningManual] = useState(false);
  const [manualDone, setManualDone] = useState(false);
  const [storageSize, setStorageSize] = useState(null);
  const [accountFolders, setAccountFolders] = useState([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Load storage stats and folder list on mount
  useEffect(() => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    invoke('maildir_storage_stats', { accountId: account.id })
      .then(stats => setStorageSize(stats?.total_bytes ?? null))
      .catch(() => {});
    // Load folder list for folder picker
    invoke('list_mailboxes', { accountJson: JSON.stringify(account) })
      .then(folders => setAccountFolders((folders || []).filter(f => !f.noselect).map(f => f.name || f.path)))
      .catch(() => {});
  }, [account.id]);

  const handleToggle = useCallback(() => {
    const newConfig = { ...config, enabled: !config.enabled };
    setBackupSchedule(account.id, newConfig);
    if (newConfig.enabled) {
      backupScheduler.startSchedule(account.id);
    } else {
      backupScheduler.stopSchedule(account.id);
    }
  }, [account.id, config, setBackupSchedule]);

  const handleConfigChange = useCallback((key, value) => {
    const newConfig = { ...config, [key]: value };
    setBackupSchedule(account.id, newConfig);
    if (newConfig.enabled) {
      backupScheduler.startSchedule(account.id);
    }
  }, [account.id, config, setBackupSchedule]);

  const handleManualBackup = useCallback(async () => {
    if (runningManual) return;
    setRunningManual(true);
    setManualDone(false);
    try {
      await backupScheduler.triggerManualBackup(account.id);
      setManualDone(true);
      setTimeout(() => setManualDone(false), 2000);
    } catch (err) {
      console.error('Manual backup failed:', err);
    } finally {
      setRunningManual(false);
    }
  }, [account.id, runningManual]);

  const avatarColor = getAccountColor(accountColors, account);
  const avatarInitial = getAccountInitial(account);
  const backedUpPercent = state.emailsBackedUp ? Math.min(100, state.emailsBackedUp) : 0;

  const scheduleContent = (
    <div className="space-y-4">
      {/* Schedule Config */}
      <AnimatePresence>
        {config.enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pt-3 border-t border-mail-border">
              <div className="grid grid-cols-2 gap-3">
                {/* Interval selector */}
                <div>
                  <label className="text-xs text-mail-text-muted mb-1 block">Interval</label>
                  <select
                    value={config.interval}
                    onChange={(e) => handleConfigChange('interval', e.target.value)}
                    className={selectClass}
                  >
                    <option value="hourly">Hourly</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>

                {/* Sub-controls */}
                {config.interval === 'hourly' && (
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">Every N hours</label>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={config.hourlyInterval || 1}
                      onChange={(e) => handleConfigChange('hourlyInterval', Math.max(1, Math.min(24, parseInt(e.target.value) || 1)))}
                      className={selectClass}
                    />
                  </div>
                )}
                {config.interval === 'daily' && (
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">At</label>
                    <input
                      type="time"
                      value={config.timeOfDay || '03:00'}
                      onChange={(e) => handleConfigChange('timeOfDay', e.target.value)}
                      className={selectClass}
                    />
                  </div>
                )}
                {config.interval === 'weekly' && (
                  <>
                    <div>
                      <label className="text-xs text-mail-text-muted mb-1 block">Day</label>
                      <select
                        value={config.dayOfWeek ?? 1}
                        onChange={(e) => handleConfigChange('dayOfWeek', parseInt(e.target.value))}
                        className={selectClass}
                      >
                        {DAY_NAMES.map((name, i) => (
                          <option key={i} value={i}>{name}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </div>

              {config.interval === 'weekly' && (
                <div className="max-w-[calc(50%-6px)]">
                  <label className="text-xs text-mail-text-muted mb-1 block">At</label>
                  <input
                    type="time"
                    value={config.timeOfDay || '03:00'}
                    onChange={(e) => handleConfigChange('timeOfDay', e.target.value)}
                    className={selectClass}
                  />
                </div>
              )}
              {/* Folder selection */}
              <div className="pt-3 border-t border-mail-border">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-mail-text-muted">Folders to back up</label>
                  <button
                    onClick={() => setShowFolderPicker(!showFolderPicker)}
                    className="text-xs text-mail-accent hover:text-mail-accent-hover"
                  >
                    {showFolderPicker ? 'Hide' : (config.folders ? `${config.folders.length} selected` : 'All folders')}
                  </button>
                </div>
                {showFolderPicker && accountFolders.length > 0 && (
                  <div className="space-y-1 max-h-32 overflow-y-auto bg-mail-bg rounded-lg p-2 border border-mail-border">
                    <label className="flex items-center gap-2 text-xs text-mail-text py-0.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!config.folders}
                        onChange={() => handleConfigChange('folders', config.folders ? null : accountFolders.slice())}
                        className="accent-mail-accent"
                      />
                      <span className="font-medium">All folders</span>
                    </label>
                    {accountFolders.map(folder => (
                      <label key={folder} className="flex items-center gap-2 text-xs text-mail-text py-0.5 cursor-pointer pl-4">
                        <input
                          type="checkbox"
                          checked={!config.folders || config.folders.includes(folder)}
                          disabled={!config.folders}
                          onChange={() => {
                            const current = config.folders || accountFolders.slice();
                            const updated = current.includes(folder)
                              ? current.filter(f => f !== folder)
                              : [...current, folder];
                            handleConfigChange('folders', updated.length === accountFolders.length ? null : updated);
                          }}
                          className="accent-mail-accent"
                        />
                        {folder}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Status Row */}
      <div className="grid grid-cols-4 gap-4 pt-3 border-t border-mail-border">
        <div>
          <div className="text-xs text-mail-text-muted">Last backup</div>
          <div className="text-sm font-semibold text-mail-text">{formatRelativeTime(state.lastBackupTime)}</div>
        </div>
        <div>
          <div className="text-xs text-mail-text-muted">Next run</div>
          <div className="text-sm font-semibold text-mail-text">{formatRelativeTime(state.nextRunTime)}</div>
        </div>
        <div>
          <div className="text-xs text-mail-text-muted">Backed up</div>
          <div className="text-sm font-semibold text-mail-accent">{backedUpPercent > 0 ? `${backedUpPercent}` : '0'} emails</div>
          <div className="h-1 rounded-full bg-mail-surface-hover mt-1">
            <div
              className="h-1 rounded-full bg-mail-accent transition-all"
              style={{ width: `${Math.min(100, backedUpPercent)}%` }}
            />
          </div>
        </div>
        <div>
          <div className="text-xs text-mail-text-muted">Storage</div>
          <div className="text-sm font-semibold text-mail-text">{formatSize(storageSize)}</div>
        </div>
      </div>

      {/* Error display */}
      {state.lastStatus === 'failed' && state.lastError && (
        <div className="text-mail-danger text-xs">
          {state.lastError}
        </div>
      )}

      {/* History Table */}
      <div className="pt-3 border-t border-mail-border">
        <div className="text-xs text-mail-text-muted mb-2">Recent backups</div>
        {history.length > 0 ? (
          <div className="space-y-1.5">
            {history.map((entry, i) => (
              <div key={i} className="flex items-center justify-between text-xs p-2 bg-mail-bg rounded-lg">
                <span className="text-mail-text-muted w-36">{formatTimestamp(entry.timestamp)}</span>
                <span className="text-mail-text w-24">{entry.emailsBackedUp} emails</span>
                <span className="text-mail-text-muted w-20">{formatDuration(entry.durationSecs)}</span>
                {entry.success ? (
                  <span className="text-emerald-500 flex items-center gap-1">
                    <CheckCircle2 size={12} /> Success
                  </span>
                ) : (
                  <span className="text-mail-danger flex items-center gap-1" title={entry.error || ''}>
                    <XCircle size={12} /> {entry.error ? entry.error.slice(0, 30) : 'Failed'}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-mail-text-muted text-xs">No backup history yet</div>
        )}
      </div>

      {/* Back up now button */}
      <div className="pt-3 border-t border-mail-border">
        <button
          onClick={handleManualBackup}
          disabled={runningManual}
          className="bg-mail-accent/10 text-mail-accent rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent/20 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {runningManual ? (
            <>
              <Loader size={14} className="animate-spin" />
              Backing up...
            </>
          ) : manualDone ? (
            <span className="text-emerald-500">Done!</span>
          ) : (
            'Back up now'
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
      {/* Account Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
            style={{ backgroundColor: avatarColor }}
          >
            {avatarInitial}
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-mail-text">{account.email}</span>
            {globalEnabled && (
              <span className="text-xs text-mail-accent ml-2">Using global schedule</span>
            )}
          </div>
        </div>
        {isPaidUser && !globalEnabled ? (
          <div aria-label={`Enable backup schedule for ${account.email}`}>
            <ToggleSwitch active={config.enabled} onClick={handleToggle} />
          </div>
        ) : null}
      </div>

      {/* Premium gate or schedule content */}
      {!isPaidUser ? (
        <div className="relative">
          {/* Blurred preview */}
          <div className="opacity-30 blur-[1px] pointer-events-none select-none" aria-hidden="true">
            {scheduleContent}
          </div>

          {/* Lock overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-mail-surface/60 backdrop-blur-[1px] rounded-lg">
            <div className="flex flex-col items-center gap-3 text-center px-6">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center">
                <Clock size={20} className="text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-mail-text mb-1">Coming Soon</p>
                <p className="text-xs text-mail-text-muted max-w-[280px]">
                  Schedule automatic backups to keep your emails safe. Set per-account schedules, track backup health, and never worry about losing important emails.
                </p>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-full">
                <Clock size={10} />
                Coming Soon
              </span>
            </div>
          </div>
        </div>
      ) : globalEnabled ? (
        // When global is enabled, show status/history but not per-account config
        <div className="space-y-4">
          {/* Status Row */}
          <div className="grid grid-cols-4 gap-4 pt-3 border-t border-mail-border">
            <div>
              <div className="text-xs text-mail-text-muted">Last backup</div>
              <div className="text-sm font-semibold text-mail-text">{formatRelativeTime(state.lastBackupTime)}</div>
            </div>
            <div>
              <div className="text-xs text-mail-text-muted">Next run</div>
              <div className="text-sm font-semibold text-mail-text">{formatRelativeTime(state.nextRunTime)}</div>
            </div>
            <div>
              <div className="text-xs text-mail-text-muted">Backed up</div>
              <div className="text-sm font-semibold text-mail-text">{state.emailsBackedUp || 0} emails</div>
            </div>
            <div>
              <div className="text-xs text-mail-text-muted">Storage</div>
              <div className="text-sm font-semibold text-mail-text">{formatSize(storageSize)}</div>
            </div>
          </div>
          {/* Manual backup button */}
          <div className="flex items-center gap-2 pt-2 border-t border-mail-border">
            <button
              onClick={handleManualBackup}
              disabled={runningManual}
              className="text-xs px-3 py-1.5 rounded-lg bg-mail-accent/10 text-mail-accent hover:bg-mail-accent/20 transition-colors flex items-center gap-1.5 font-medium"
            >
              {runningManual ? <Loader size={12} className="animate-spin" /> : manualDone ? <CheckCircle2 size={12} /> : <HardDrive size={12} />}
              {runningManual ? 'Backing up...' : manualDone ? 'Done!' : 'Back up now'}
            </button>
          </div>
        </div>
      ) : (
        scheduleContent
      )}
    </div>
  );
}

export default function BackupSettings() {
  const accounts = useMailStore(s => s.accounts);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accountOrder = useSettingsStore(s => s.accountOrder);
  const isPaidUser = useSettingsStore(s => s.isPaidUser);
  const setIsPaidUser = useSettingsStore(s => s.setIsPaidUser);

  const backupNotifyOnSuccess = useSettingsStore(s => s.backupNotifyOnSuccess);
  const backupNotifyOnFailure = useSettingsStore(s => s.backupNotifyOnFailure);
  const setBackupNotifyOnSuccess = useSettingsStore(s => s.setBackupNotifyOnSuccess);
  const setBackupNotifyOnFailure = useSettingsStore(s => s.setBackupNotifyOnFailure);

  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const setBackupGlobalEnabled = useSettingsStore(s => s.setBackupGlobalEnabled);
  const setBackupGlobalConfig = useSettingsStore(s => s.setBackupGlobalConfig);
  const backupScope = useSettingsStore(s => s.backupScope);
  const setBackupScope = useSettingsStore(s => s.setBackupScope);
  const backupCustomPath = useSettingsStore(s => s.backupCustomPath);
  const setBackupCustomPath = useSettingsStore(s => s.setBackupCustomPath);

  const [showExportChoice, setShowExportChoice] = useState(false);
  const [defaultBackupPath, setDefaultBackupPath] = useState(null);

  // Load default backup path on mount
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (inv) inv('get_app_data_dir').then(p => setDefaultBackupPath(p)).catch(() => {});
  }, []);

  const handleChooseBackupDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, title: 'Choose backup directory' });
      if (selected) setBackupCustomPath(selected);
    } catch (e) {
      console.error('Directory picker failed:', e);
    }
  };

  const invoke = window.__TAURI__?.core?.invoke;

  const visibleAccounts = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);

  // Export backup as ZIP of .eml files via Rust
  const handleExportData = () => {
    if (!invoke) {
      alert('Backup export is only available in the desktop app.');
      return;
    }
    setShowExportChoice(true);
  };

  const doExport = async (archivedOnly) => {
    setShowExportChoice(false);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');

      const destPath = await save({
        defaultPath: `mailvault-backup-${new Date().toISOString().split('T')[0]}.zip`,
        filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
      });

      if (!destPath) return;

      const settingsData = {
        theme: safeStorage.getItem('mailvault-theme'),
        settings: safeStorage.getItem('mailvault-settings'),
      };

      const db = await import('../../services/db');
      await db.initDB();
      const accountsList = await db.getAccountsWithoutPasswords();
      const backupAccounts = accountsList.map(a => ({
        email: a.email,
        imapServer: a.imapServer,
        smtpServer: a.smtpServer,
      }));

      // Show progress modal
      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'export' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('export-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'export'
        });
      });

      try {
        await invoke('export_backup', {
          destPath,
          archivedOnly,
          settingsJson: JSON.stringify(settingsData),
          accountsJson: JSON.stringify(backupAccounts),
        });
      } finally {
        unlisten();
      }

      // Auto-dismiss after 3 seconds
      setTimeout(() => useMailStore.getState().dismissExportProgress(), 3000);
    } catch (error) {
      console.error('Export error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to export backup: ' + (error.message || error));
    }
  };

  // Import backup from ZIP via Rust
  const handleImportData = async () => {
    if (!invoke) {
      alert('Backup import is only available in the desktop app.');
      return;
    }

    try {
      const { open } = await import('@tauri-apps/plugin-dialog');

      const sourcePath = await open({
        filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
        multiple: false,
      });

      if (!sourcePath) return;

      // Show progress modal
      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'import' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('import-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'import'
        });
      });

      let result;
      try {
        result = await invoke('import_backup', { sourcePath });
      } finally {
        unlisten();
      }

      // Restore settings if present
      if (result.settingsJson) {
        try {
          const settings = JSON.parse(result.settingsJson);
          if (settings.theme) safeStorage.setItem('mailvault-theme', settings.theme);
          if (settings.settings) safeStorage.setItem('mailvault-settings', settings.settings);
        } catch (e) {
          console.warn('Failed to restore settings:', e);
        }
      }

      // Show completion briefly then reload
      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        let msg = `Backup imported successfully!\n\n${result.emailCount} email(s) from ${result.accountCount} account(s).`;
        if (result.newAccounts.length > 0) {
          msg += `\n\nNew accounts created (re-enter passwords in Settings):\n\u2022 ${result.newAccounts.join('\n\u2022 ')}`;
        }
        alert(msg + '\n\nThe page will reload.');
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('Import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to import backup: ' + (error.message || error));
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Backup & Restore (instant backup) */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent" />
          Backup & Restore
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          Export your data to create a backup file, or import a previous backup to restore your emails.
        </p>

        <div className="flex gap-3">
          <button
            onClick={handleExportData}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                      bg-mail-accent/10 hover:bg-mail-accent/20 text-mail-accent
                      rounded-lg transition-colors"
          >
            <Download size={18} />
            Export Backup
          </button>

          <button
            onClick={handleImportData}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                      bg-mail-surface-hover hover:bg-mail-border text-mail-text
                      rounded-lg transition-colors"
          >
            <Upload size={18} />
            Import Backup
          </button>
        </div>
      </div>

      {/* Global Controls */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <AlertCircle size={18} className="text-mail-accent" />
          Notification Preferences
        </h4>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">Notify when backup completes</span>
            <ToggleSwitch active={backupNotifyOnSuccess} onClick={() => setBackupNotifyOnSuccess(!backupNotifyOnSuccess)} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">Notify when backup fails</span>
            <ToggleSwitch active={backupNotifyOnFailure} onClick={() => setBackupNotifyOnFailure(!backupNotifyOnFailure)} />
          </div>
        </div>
      </div>

      {/* Backup Scope & Storage */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5 space-y-4">
        <h4 className="font-semibold text-mail-text flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent" />
          Backup Scope & Storage
        </h4>

        {/* Explanation */}
        <div className="bg-mail-bg rounded-lg p-3">
          <p className="text-xs text-mail-text-muted">
            {backupScope === 'archived'
              ? 'Only emails you have explicitly archived (saved locally) will be backed up. To include all server emails, switch to "All emails" below.'
              : 'All emails from selected folders on the mail server will be downloaded and backed up locally. This may use significant disk space.'}
          </p>
        </div>

        {/* Scope selector */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">What to back up</label>
          <select
            value={backupScope}
            onChange={(e) => setBackupScope(e.target.value)}
            className={selectClass}
          >
            <option value="archived">Archived emails only (locally saved)</option>
            <option value="all">All emails (download from server)</option>
          </select>
        </div>

        {/* Storage directory */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">Backup location</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-mail-text font-mono bg-mail-bg rounded-lg px-3 py-2 truncate border border-mail-border">
              {backupCustomPath || defaultBackupPath || 'Loading...'}
            </div>
            <button
              onClick={handleChooseBackupDir}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover transition-colors whitespace-nowrap"
            >
              Change
            </button>
            {backupCustomPath && (
              <button
                onClick={() => setBackupCustomPath(null)}
                className="text-xs text-mail-text-muted hover:text-mail-text px-2 py-2"
                title="Reset to default"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Global Backup Schedule */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="font-semibold text-mail-text flex items-center gap-2">
              <Clock size={18} className="text-mail-accent" />
              Backup Schedule
            </h4>
            <p className="text-xs text-mail-text-muted mt-0.5">
              {backupGlobalEnabled ? 'All accounts use this schedule' : 'Enable to set a schedule for all accounts'}
            </p>
          </div>
          <ToggleSwitch active={backupGlobalEnabled} onClick={() => setBackupGlobalEnabled(!backupGlobalEnabled)} />
        </div>

        <AnimatePresence>
          {backupGlobalEnabled && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-3 pt-3 border-t border-mail-border">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">Interval</label>
                    <select
                      value={backupGlobalConfig.interval}
                      onChange={(e) => setBackupGlobalConfig({ interval: e.target.value })}
                      className={selectClass}
                    >
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>

                  {backupGlobalConfig.interval === 'hourly' && (
                    <div>
                      <label className="text-xs text-mail-text-muted mb-1 block">Every N hours</label>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={backupGlobalConfig.hourlyInterval || 1}
                        onChange={(e) => setBackupGlobalConfig({ hourlyInterval: Math.max(1, Math.min(24, parseInt(e.target.value) || 1)) })}
                        className={selectClass}
                      />
                    </div>
                  )}
                  {backupGlobalConfig.interval === 'daily' && (
                    <div>
                      <label className="text-xs text-mail-text-muted mb-1 block">At</label>
                      <input
                        type="time"
                        value={backupGlobalConfig.timeOfDay || '03:00'}
                        onChange={(e) => setBackupGlobalConfig({ timeOfDay: e.target.value })}
                        className={selectClass}
                      />
                    </div>
                  )}
                  {backupGlobalConfig.interval === 'weekly' && (
                    <>
                      <div>
                        <label className="text-xs text-mail-text-muted mb-1 block">Day</label>
                        <select
                          value={backupGlobalConfig.dayOfWeek ?? 1}
                          onChange={(e) => setBackupGlobalConfig({ dayOfWeek: parseInt(e.target.value) })}
                          className={selectClass}
                        >
                          {DAY_NAMES.map((name, i) => (
                            <option key={i} value={i}>{name}</option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                </div>

                {backupGlobalConfig.interval === 'weekly' && (
                  <div className="max-w-[calc(50%-6px)]">
                    <label className="text-xs text-mail-text-muted mb-1 block">At</label>
                    <input
                      type="time"
                      value={backupGlobalConfig.timeOfDay || '03:00'}
                      onChange={(e) => setBackupGlobalConfig({ timeOfDay: e.target.value })}
                      className={selectClass}
                    />
                  </div>
                )}

                <p className="text-xs text-mail-text-muted pt-1">
                  Turn off to configure each account individually below.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Per-Account Cards */}
      {!backupGlobalEnabled && (
        <div className="flex items-center gap-2 pt-2">
          <h4 className="text-sm font-semibold text-mail-text-muted">Per-Account Settings</h4>
        </div>
      )}
      {visibleAccounts.length > 0 ? (
        visibleAccounts.map(account => (
          <AccountCard key={account.id} account={account} isPaidUser={isPaidUser} globalEnabled={backupGlobalEnabled} />
        ))
      ) : (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5 text-center">
          <h4 className="font-semibold text-mail-text mb-2">No accounts configured</h4>
          <p className="text-sm text-mail-text-muted">
            Add an email account first, then configure backup schedules.
          </p>
        </div>
      )}

      {/* Developer: Premium toggle */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-3 flex items-center gap-2">
          <Wrench size={18} className="text-mail-text-muted" />
          Developer
        </h4>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-mail-text">Enable premium features</span>
            <p className="text-xs text-mail-text-muted mt-0.5">Toggle to test premium-gated features like scheduled backups</p>
          </div>
          <ToggleSwitch active={isPaidUser} onClick={() => setIsPaidUser(!isPaidUser)} />
        </div>
      </div>

      {/* Export choice modal */}
      <AnimatePresence>
        {showExportChoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
            onClick={() => setShowExportChoice(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-mail-bg border border-mail-border rounded-xl shadow-xl max-w-sm w-full mx-4 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">Export Backup</h3>
              <p className="text-sm text-mail-text-muted mb-5">
                Which emails would you like to export?
              </p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => doExport(true)}
                  className="w-full px-4 py-3 bg-mail-accent hover:bg-mail-accent-hover
                            text-white rounded-lg font-medium transition-colors text-left"
                >
                  <span className="block">Archived Emails</span>
                  <span className="block text-xs font-normal opacity-80 mt-0.5">Only emails you've explicitly saved to your device</span>
                </button>
                <button
                  onClick={() => setShowExportChoice(false)}
                  className="w-full px-4 py-2 text-sm text-mail-text-muted hover:text-mail-text
                            transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
