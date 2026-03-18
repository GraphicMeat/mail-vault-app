import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';
import { backupScheduler } from '../../services/backupScheduler';
import { ToggleSwitch } from './ToggleSwitch';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader,
  Shield,
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

function AccountCard({ account, isPaidUser }) {
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

  // Load storage stats on mount
  useEffect(() => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    invoke('maildir_storage_stats', { accountId: account.id })
      .then(stats => setStorageSize(stats?.total_bytes ?? null))
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
          <span className="text-sm font-medium text-mail-text">{account.email}</span>
        </div>
        {isPaidUser ? (
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
      ) : (
        scheduleContent
      )}
    </div>
  );
}

export default function BackupSettings() {
  const accounts = useMailStore(s => s.accounts);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const isPaidUser = useSettingsStore(s => s.isPaidUser);
  const backupNotifyOnSuccess = useSettingsStore(s => s.backupNotifyOnSuccess);
  const backupNotifyOnFailure = useSettingsStore(s => s.backupNotifyOnFailure);
  const setBackupNotifyOnSuccess = useSettingsStore(s => s.setBackupNotifyOnSuccess);
  const setBackupNotifyOnFailure = useSettingsStore(s => s.setBackupNotifyOnFailure);

  const visibleAccounts = (accounts || []).filter(a => !hiddenAccounts?.[a.id]);

  if (!visibleAccounts.length) {
    return (
      <div className="p-6">
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5 text-center">
          <h4 className="font-semibold text-mail-text mb-2">No backup schedules configured</h4>
          <p className="text-sm text-mail-text-muted">
            Enable automatic backup for an account to keep your emails safely archived. Backups run in the background, even when the app is minimized.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
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

      {/* Per-Account Cards */}
      {visibleAccounts.map(account => (
        <AccountCard key={account.id} account={account} isPaidUser={isPaidUser} />
      ))}
    </div>
  );
}
