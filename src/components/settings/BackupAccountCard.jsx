import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor, hasPremiumAccess } from '../../stores/settingsStore';
import { backupScheduler } from '../../services/backupScheduler';
import * as api from '../../services/api';
import { resolveServerAccount } from '../../services/authUtils';
import { ToggleSwitch } from './ToggleSwitch';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDateTime } from '../../utils/dateFormat';
import BackupVerificationTree from './BackupVerificationTree';
import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader,
  Shield,
  HardDrive,
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
  return formatDateTime(ts) || '--';
}

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

const BackupAccountCard = React.forwardRef(function BackupAccountCard({ account, isPaidUser, globalEnabled, highlighted, onUpgrade }, ref) {
  const backupSchedules = useSettingsStore(s => s.backupSchedules);
  const backupState = useSettingsStore(s => s.backupState);
  const backupHistory = useSettingsStore(s => s.backupHistory);
  const accountColors = useSettingsStore(s => s.accountColors);
  const setBackupSchedule = useSettingsStore(s => s.setBackupSchedule);
  const globalScope = useSettingsStore(s => s.backupScope);

  const config = backupSchedules[account.id] || { enabled: false, interval: 'daily', hourlyInterval: 1, timeOfDay: '03:00', dayOfWeek: 1 };
  const state = backupState[account.id] || {};
  const history = (backupHistory[account.id] || []).slice(0, 5);

  const [runningManual, setRunningManual] = useState(false);
  const [manualStatus, setManualStatus] = useState('idle');
  const [manualError, setManualError] = useState(null);
  const [storageSize, setStorageSize] = useState(null);
  const [accountFolders, setAccountFolders] = useState([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [backupProgress, setBackupProgress] = useState(null);
  const [archiveProgress, setArchiveProgress] = useState(null);
  const [backupStatusData, setBackupStatusData] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [backupStatusError, setBackupStatusError] = useState(null);

  useEffect(() => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    invoke('maildir_storage_stats', { accountId: account.id })
      .then(stats => setStorageSize(stats?.total_bytes ?? null))
      .catch(() => {});
    invoke('list_mailboxes', { accountJson: JSON.stringify(account) })
      .then(folders => setAccountFolders((folders || []).filter(f => !f.noselect).map(f => f.name || f.path)))
      .catch(() => {});
  }, [account.id]);

  useEffect(() => {
    let unlistenBackup, unlistenArchive;
    let isBackupActive = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenBackup = await listen('backup-progress', (event) => {
          const p = event.payload;
          if (p.account_id === account.id) {
            isBackupActive = p.active;
            setBackupProgress(p);
            if (!p.active) {
              setArchiveProgress(null);
              setTimeout(() => setBackupProgress(null), 2000);
            }
          }
        });
        unlistenArchive = await listen('archive-progress', (event) => {
          const p = event.payload;
          if (isBackupActive) {
            setArchiveProgress(p.active ? { total: p.total, completed: p.completed } : null);
          }
        });
      } catch {}
    })();
    return () => { unlistenBackup?.(); unlistenArchive?.(); };
  }, [account.id]);

  const handleToggle = useCallback(() => {
    const newConfig = { ...config, enabled: !config.enabled };
    setBackupSchedule(account.id, newConfig);
  }, [account.id, config, setBackupSchedule]);

  const handleConfigChange = useCallback((key, value) => {
    const newConfig = { ...config, [key]: value };
    setBackupSchedule(account.id, newConfig);
  }, [account.id, config, setBackupSchedule]);

  const handleManualBackup = useCallback(async () => {
    if (runningManual) return;
    setRunningManual(true);
    setManualStatus('idle');
    setManualError(null);
    try {
      const result = await backupScheduler.triggerManualBackup(account.id);
      if (result.status === 'success') {
        setManualStatus('success');
        setTimeout(() => setManualStatus('idle'), 2000);
      } else if (result.status === 'degraded') {
        setManualStatus('degraded');
        setManualError(result.message || 'Backed up locally, but external backup failed for some emails.');
        setTimeout(() => setManualStatus('idle'), 5000);
      } else {
        setManualStatus('error');
        setManualError(result.message || 'Backup failed');
      }
    } catch (err) {
      console.error('Manual backup failed:', err);
      setManualStatus('error');
      setManualError(err.message || 'Backup failed');
    } finally {
      setRunningManual(false);
    }
  }, [account.id, runningManual]);

  const avatarColor = getAccountColor(accountColors, account);
  const avatarInitial = getAccountInitial(account);

  const verificationSection = (
    <div className="pt-3 border-t border-mail-border">
      {backupStatusData ? (
        <BackupVerificationTree data={backupStatusData} onHide={() => setBackupStatusData(null)} />
      ) : (
        <div className="space-y-2">
          <button
            onClick={async () => {
              setLoadingStatus(true);
              setBackupStatusError(null);
              try {
                const resolved = await resolveServerAccount(account.id, account);
                if (!resolved.ok) throw new Error(resolved.message);
                const result = await api.backupStatus(account.id, JSON.stringify(resolved.account), null);
                setBackupStatusData(result);
                if (!result?.folders?.length && !result?.total_server && !result?.total_app && !result?.total_external) {
                  setBackupStatusError('No backup coverage data is available for this account yet.');
                }
              } catch (e) {
                console.error('Backup status check failed:', e);
                setBackupStatusError(e?.message || 'Could not verify backup coverage for this account.');
              } finally {
                setLoadingStatus(false);
              }
            }}
            disabled={loadingStatus}
            className="text-xs text-mail-accent hover:text-mail-accent-hover flex items-center gap-1"
          >
            {loadingStatus ? <Loader size={10} className="animate-spin" /> : <Shield size={10} />}
            {loadingStatus ? 'Checking...' : 'Verify backup coverage'}
          </button>
          {backupStatusError && (
            <div className="text-xs text-mail-warning">
              {backupStatusError}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const scheduleContent = (
    <div className="space-y-4">
      <AnimatePresence>
        {(config.enabled || globalEnabled) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pt-3 border-t border-mail-border">
              <div className="pt-3 border-t border-mail-border">
                <label className="text-xs text-mail-text-muted mb-1 block">What to back up</label>
                <select
                  value={config.scope || ''}
                  onChange={(e) => handleConfigChange('scope', e.target.value || null)}
                  className={selectClass}
                >
                  <option value="">Use global setting ({globalScope === 'all' ? 'All emails' : 'Archived only'})</option>
                  <option value="archived">Archived emails only</option>
                  <option value="all">All emails (download from server)</option>
                </select>
              </div>

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
      <div className="grid grid-cols-3 gap-4 pt-3 border-t border-mail-border">
        <div>
          <div className="text-xs text-mail-text-muted">Last backup</div>
          <div className="text-sm font-semibold text-mail-text">{formatRelativeTime(state.lastBackupTime)}</div>
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

      {verificationSection}

      {state.lastStatus === 'failed' && state.lastError && (
        <div className="text-mail-danger text-xs">{state.lastError}</div>
      )}
      {state.lastStatus === 'degraded' && (
        <div className="flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{state.lastError || 'Backed up locally, but external backup failed for some emails.'}</span>
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
                {entry.success && entry.externalCopyOk !== false ? (
                  <span className="text-emerald-500 flex items-center gap-1">
                    <CheckCircle2 size={12} /> Success
                  </span>
                ) : entry.success && entry.externalCopyOk === false ? (
                  <span className="text-amber-500 flex items-center gap-1" title={entry.externalCopyError || 'External copy failed'}>
                    <AlertCircle size={12} /> Partial
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

      {/* Back up now button + live progress */}
      <div className="pt-3 border-t border-mail-border space-y-2">
        {backupProgress && backupProgress.active && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-mail-text font-medium">
                {backupProgress.folder || 'Starting...'} ({backupProgress.completed_folders}/{backupProgress.total_folders} folders)
              </span>
              <span className="text-mail-text-muted">
                {backupProgress.completed_emails} emails backed up
                {backupProgress.missing_in_folder > 0 && ` · ${backupProgress.missing_in_folder} to download`}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
              <div
                className="h-1.5 rounded-full bg-mail-accent transition-all"
                style={{ width: `${backupProgress.total_folders > 0 ? Math.round((backupProgress.completed_folders / backupProgress.total_folders) * 100) : 0}%` }}
              />
            </div>
            {archiveProgress && archiveProgress.total > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-mail-text-muted">
                  <span>Downloading: {archiveProgress.completed}/{archiveProgress.total} emails</span>
                  <span>{Math.round((archiveProgress.completed / archiveProgress.total) * 100)}%</span>
                </div>
                <div className="h-1 rounded-full bg-mail-border overflow-hidden">
                  <div className="h-1 rounded-full bg-mail-success transition-all" style={{ width: `${Math.round((archiveProgress.completed / archiveProgress.total) * 100)}%` }} />
                </div>
              </div>
            )}
          </div>
        )}
        <button
          onClick={handleManualBackup}
          disabled={runningManual}
          className="bg-mail-accent/10 text-mail-accent rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent/20 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {runningManual ? (
            <>
              <Loader size={14} className="animate-spin" />
              {backupProgress ? `Backing up ${backupProgress.folder || ''}...` : 'Backing up...'}
            </>
          ) : manualStatus === 'success' ? (
            <span className="text-emerald-500">Done!</span>
          ) : manualStatus === 'degraded' ? (
            <span className="text-amber-500">Partial</span>
          ) : (
            'Back up now'
          )}
        </button>
        {manualStatus === 'degraded' && manualError && (
          <div className="text-xs text-amber-500">{manualError}</div>
        )}
        {manualStatus === 'error' && manualError && (
          <div className="text-xs text-mail-warning">{manualError}</div>
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={ref}
      className={`bg-mail-surface border rounded-xl p-5 transition-all duration-500 ${
        highlighted ? 'border-mail-accent ring-2 ring-mail-accent/30' : 'border-mail-border'
      }`}
    >
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
          <div className="opacity-30 blur-[1px] pointer-events-none select-none" aria-hidden="true">
            {scheduleContent}
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-mail-surface/60 backdrop-blur-[1px] rounded-lg">
            <div className="flex flex-col items-center gap-3 text-center px-6">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center">
                <Clock size={20} className="text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-mail-text mb-1">Premium Feature</p>
                <p className="text-xs text-mail-text-muted max-w-[280px]">
                  Schedule automatic backups to keep your emails safe. Set per-account schedules, track backup health, and never worry about losing important emails.
                </p>
                <p className="text-xs text-mail-text-muted mt-1">$3/month or $25/year</p>
              </div>
              {onUpgrade && (
                <button onClick={onUpgrade} className="px-4 py-1.5 text-xs font-semibold bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-full hover:opacity-90 transition-opacity">
                  Upgrade
                </button>
              )}
            </div>
          </div>
        </div>
      ) : globalEnabled ? (
        <div className="space-y-4">
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
          {verificationSection}
          <div className="pt-2 border-t border-mail-border space-y-2">
            {runningManual && backupProgress && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-mail-text">{backupProgress.folder} ({backupProgress.completed_folders}/{backupProgress.total_folders})</span>
                  <span className="text-mail-text-muted">{backupProgress.completed_emails} emails</span>
                </div>
                <div className="h-1 rounded-full bg-mail-border overflow-hidden">
                  <div className="h-1 rounded-full bg-mail-accent transition-all" style={{ width: `${backupProgress.total_folders > 0 ? Math.round((backupProgress.completed_folders / backupProgress.total_folders) * 100) : 0}%` }} />
                </div>
              </div>
            )}
            <button
              onClick={handleManualBackup}
              disabled={runningManual}
              className="text-xs px-3 py-1.5 rounded-lg bg-mail-accent/10 text-mail-accent hover:bg-mail-accent/20 transition-colors flex items-center gap-1.5 font-medium"
            >
              {runningManual ? <Loader size={12} className="animate-spin" /> : manualStatus === 'success' ? <CheckCircle2 size={12} /> : <HardDrive size={12} />}
              {runningManual ? `Backing up ${backupProgress?.folder || ''}...` : manualStatus === 'success' ? 'Done!' : 'Back up now'}
            </button>
            {manualStatus === 'error' && manualError && (
              <div className="text-xs text-mail-warning">{manualError}</div>
            )}
          </div>
        </div>
      ) : (
        scheduleContent
      )}
    </div>
  );
});

export default BackupAccountCard;
