import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor, hasPremiumAccess } from '../../stores/settingsStore';
import { useBackupStore } from '../../stores/backupStore';
import { useMailStore } from '../../stores/mailStore';
import { backupScheduler } from '../../services/backupScheduler';
import * as api from '../../services/api';
import { resolveServerAccount } from '../../services/authUtils';
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
  ChevronDown,
  ChevronRight,
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

// ── Folder verification tree ──────────────────────────────────────────────────

function CountCell({ count, serverCount }) {
  if (serverCount === 0) return <span className="text-mail-text-muted">--</span>;
  const complete = count >= serverCount;
  return (
    <span className={complete ? 'text-mail-success' : 'text-mail-warning'}>
      {count}
    </span>
  );
}

function FolderRow({ folder, depth = 0, hasExternal, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = folder.children?.length > 0;
  const isContainer = folder.server_count === 0 && hasChildren; // noselect folder

  return (
    <>
      <tr className="text-xs border-b border-mail-border hover:bg-mail-surface-hover/50">
        <td className="py-1 pr-2">
          <div className="flex items-center" style={{ paddingLeft: depth * 16 }}>
            {hasChildren ? (
              <button onClick={() => setExpanded(!expanded)} className="p-0.5 -ml-1 mr-0.5 text-mail-text-muted hover:text-mail-text">
                {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              </button>
            ) : (
              <span className="w-4" />
            )}
            <span className={`truncate ${isContainer ? 'text-mail-text-muted italic' : 'text-mail-text'}`}>
              {folder.name || folder.path}
            </span>
          </div>
        </td>
        <td className="py-1 px-2 text-right tabular-nums">
          {isContainer ? <span className="text-mail-text-muted">--</span> : <span className="text-mail-text">{folder.server_count}</span>}
        </td>
        <td className="py-1 px-2 text-right tabular-nums">
          {isContainer ? <span className="text-mail-text-muted">--</span> : <CountCell count={folder.app_count} serverCount={folder.server_count} />}
        </td>
        {hasExternal && (
          <td className="py-1 px-2 text-right tabular-nums">
            {isContainer ? <span className="text-mail-text-muted">--</span> : <CountCell count={folder.external_count} serverCount={folder.server_count} />}
          </td>
        )}
      </tr>
      {expanded && hasChildren && folder.children.map(child => (
        <FolderRow key={child.path} folder={child} depth={depth + 1} hasExternal={hasExternal} />
      ))}
    </>
  );
}

function BackupVerificationTree({ data, onHide }) {
  const { total_server, total_app, total_external, external_available, folders } = data;
  const hasExternal = external_available || total_external > 0;
  const appComplete = total_app >= total_server && total_server > 0;
  const extComplete = hasExternal && total_external >= total_server && total_server > 0;
  const appPct = total_server > 0 ? Math.round((total_app / total_server) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-mail-text">Backup Verification</span>
        <button onClick={onHide} className="text-xs text-mail-text-muted hover:text-mail-text">Hide</button>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-1.5">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
          appComplete ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'
        }`}>
          {appComplete ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
          App: {appPct}%
        </span>
        {hasExternal ? (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            extComplete ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'
          }`}>
            {extComplete ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
            External: {total_server > 0 ? Math.round((total_external / total_server) * 100) : 0}%
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-mail-surface text-mail-text-muted">
            External: not configured
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
        <div
          className={`h-1.5 rounded-full transition-all ${appComplete ? 'bg-mail-success' : 'bg-mail-warning'}`}
          style={{ width: `${Math.min(100, appPct)}%` }}
        />
      </div>

      {/* Folder tree table */}
      {folders.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-mail-border bg-mail-bg">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-mail-surface">
              <tr className="border-b border-mail-border text-mail-text-muted">
                <th className="py-1 pr-2 text-left font-medium">Folder</th>
                <th className="py-1 px-2 text-right font-medium w-14">Server</th>
                <th className="py-1 px-2 text-right font-medium w-14">App</th>
                {hasExternal && <th className="py-1 px-2 text-right font-medium w-14">Ext.</th>}
              </tr>
            </thead>
            <tbody>
              {folders.map(f => (
                <FolderRow key={f.path} folder={f} hasExternal={hasExternal} defaultExpanded={folders.length <= 8} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Totals */}
      <div className="flex items-center justify-between text-xs text-mail-text-muted pt-1">
        <span>Total: {total_app}/{total_server} in app{hasExternal && `, ${total_external}/${total_server} external`}</span>
      </div>
    </div>
  );
}

const AccountCard = React.forwardRef(function AccountCard({ account, isPaidUser, globalEnabled, highlighted, onUpgrade }, ref) {
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
  const [manualStatus, setManualStatus] = useState('idle'); // idle | success | degraded | error
  const [manualError, setManualError] = useState(null);
  const [storageSize, setStorageSize] = useState(null);
  const [accountFolders, setAccountFolders] = useState([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [backupProgress, setBackupProgress] = useState(null);
  const [archiveProgress, setArchiveProgress] = useState(null);
  const [backupStatusData, setBackupStatusData] = useState(null); // { folders, total_server, total_local }
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [backupStatusError, setBackupStatusError] = useState(null);

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

  // Listen to backup-progress and archive-progress events
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
          // Only update archive progress when this account's backup is actively running
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
  const backedUpPercent = state.emailsBackedUp ? Math.min(100, state.emailsBackedUp) : 0;

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
                // External path resolved natively in Rust via bookmark — pass null
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
      {/* Per-account config (scope + folders) */}
      <AnimatePresence>
        {(config.enabled || globalEnabled) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pt-3 border-t border-mail-border">
              {/* Per-account backup scope */}
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

      {/* Backup verification */}
      {verificationSection}

      {/* Error / degraded display */}
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
          {verificationSection}
          {/* Manual backup button + progress */}
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

export default function BackupSettings({ initialAccountId = null, onUpgrade }) {
  const cardRefs = useRef({});
  const [highlightedId, setHighlightedId] = useState(null);

  // Scroll to and highlight the target account card
  useEffect(() => {
    if (!initialAccountId) return;
    // Small delay to let the cards render
    const timer = setTimeout(() => {
      const el = cardRefs.current[initialAccountId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedId(initialAccountId);
        // Clear highlight after animation
        setTimeout(() => setHighlightedId(null), 2000);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [initialAccountId]);
  const accounts = useMailStore(s => s.accounts);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accountOrder = useSettingsStore(s => s.accountOrder);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPaidUser = hasPremiumAccess(billingProfile);

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
  const externalBackupLocation = useSettingsStore(s => s.externalBackupLocation);
  const setExternalBackupLocation = useSettingsStore(s => s.setExternalBackupLocation);

  const activeBackup = useBackupStore(s => s.activeBackup);
  const [showExportChoice, setShowExportChoice] = useState(false);
  const [defaultBackupPath, setDefaultBackupPath] = useState(null);
  const [validatingExternal, setValidatingExternal] = useState(false);

  // Load default backup path and external location on mount
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (!inv) return;
    inv('get_app_data_dir').then(p => setDefaultBackupPath(p)).catch(() => {});
    // Load stored external location
    inv('backup_get_external_location').then(loc => {
      if (loc?.status !== 'not_configured') setExternalBackupLocation(loc);
    }).catch(() => {});
    // Migrate legacy backupCustomPath if no external location exists
    const legacy = useSettingsStore.getState().backupCustomPath;
    if (legacy) {
      inv('backup_migrate_legacy_path', { legacyPath: legacy }).then(loc => {
        setExternalBackupLocation(loc);
        // Clear legacy after migration
        if (loc.status === 'ready') setBackupCustomPath(null);
      }).catch(() => {});
    }
  }, []);

  const handleChooseBackupDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, title: 'Choose external backup directory' });
      if (!selected) return;
      const inv = window.__TAURI__?.core?.invoke;
      if (inv) {
        const loc = await inv('backup_save_external_location', { path: selected });
        setExternalBackupLocation(loc);
        setBackupCustomPath(null); // clear legacy
      }
    } catch (e) {
      console.error('Directory picker failed:', e);
    }
  };

  const handleValidateExternal = async () => {
    setValidatingExternal(true);
    try {
      const inv = window.__TAURI__?.core?.invoke;
      if (inv) {
        const loc = await inv('backup_validate_external_location');
        setExternalBackupLocation(loc);
      }
    } catch { /* handled by loc.lastError */ }
    setValidatingExternal(false);
  };

  const handleClearExternal = async () => {
    try {
      const inv = window.__TAURI__?.core?.invoke;
      if (inv) await inv('backup_clear_external_location');
      setExternalBackupLocation(null);
      setBackupCustomPath(null);
    } catch { /* ignore */ }
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
          <p className="text-xs text-mail-text-muted mt-1">
            Backups are incremental — only new emails since the last backup are downloaded. Existing backups are never re-downloaded.
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

        {/* External backup location */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">External backup location</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-mail-text font-mono bg-mail-bg rounded-lg px-3 py-2 truncate border border-mail-border">
              {externalBackupLocation?.displayPath || (defaultBackupPath ? `${defaultBackupPath}/Maildir (app only)` : 'Loading...')}
            </div>
            <button
              onClick={handleChooseBackupDir}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover transition-colors whitespace-nowrap"
            >
              {externalBackupLocation ? 'Change' : 'Choose Folder'}
            </button>
            {externalBackupLocation && (
              <button
                onClick={handleClearExternal}
                className="text-xs text-mail-text-muted hover:text-mail-text px-2 py-2"
                title="Remove external backup location"
              >
                Reset
              </button>
            )}
          </div>

          {/* Status badge + validation */}
          {externalBackupLocation && (
            <div className="mt-2 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                externalBackupLocation.status === 'ready' ? 'bg-emerald-500/10 text-emerald-500'
                : externalBackupLocation.status === 'needs_reauth' ? 'bg-amber-500/10 text-amber-500'
                : 'bg-red-500/10 text-red-500'
              }`}>
                {externalBackupLocation.status === 'ready' ? 'Ready'
                  : externalBackupLocation.status === 'needs_reauth' ? 'Needs reauthorization'
                  : externalBackupLocation.status === 'unavailable' ? 'Unavailable'
                  : externalBackupLocation.status === 'invalid' ? 'Access denied'
                  : externalBackupLocation.status}
              </span>
              <button
                onClick={externalBackupLocation.status === 'needs_reauth' ? handleChooseBackupDir : handleValidateExternal}
                disabled={validatingExternal}
                className="text-xs text-mail-accent hover:text-mail-accent-hover"
              >
                {validatingExternal ? 'Checking...' : externalBackupLocation.status === 'needs_reauth' ? 'Reauthorize' : 'Test access'}
              </button>
            </div>
          )}

          {/* Error detail */}
          {externalBackupLocation?.lastError && externalBackupLocation.status !== 'ready' && (
            <p className="mt-1 text-xs text-mail-danger">{externalBackupLocation.lastError}</p>
          )}

          {externalBackupLocation?.status === 'ready' ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-mail-success">
                Emails are saved as .eml files during each backup, organized by account and folder. Safe from app uninstalls.
              </p>
              <p className="text-xs text-mail-text-muted">
                Structure: <code className="text-mail-text">{externalBackupLocation.displayPath}/email@address/INBOX/cur/1234.eml</code>
              </p>
            </div>
          ) : !externalBackupLocation ? (
            <div className="mt-2 flex items-start gap-2 bg-mail-warning/10 border border-mail-warning/30 rounded-lg p-2">
              <AlertCircle size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-mail-warning">
                Backups are only stored inside the app's data folder. If you uninstall MailVault or clear app data, your backups will be lost. Choose an external folder to keep a safe copy.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {/* Automatic Backup */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="font-semibold text-mail-text flex items-center gap-2">
              <Clock size={18} className="text-mail-accent" />
              Automatic Backup
            </h4>
            <p className="text-xs text-mail-text-muted mt-0.5">
              Backups run automatically when the app is idle
            </p>
          </div>
          <ToggleSwitch active={backupGlobalEnabled} onClick={() => setBackupGlobalEnabled(!backupGlobalEnabled)} />
        </div>

        {backupGlobalEnabled && (
          <div className="space-y-3 pt-3 border-t border-mail-border">
            <div className="bg-mail-bg rounded-lg p-3">
              <p className="text-xs text-mail-text-muted">
                When you stop using the app for a few minutes, MailVault checks if any accounts need a backup and runs them one at a time in the background. No interruptions, no schedules to configure.
              </p>
            </div>
            <div>
              <label className="text-xs text-mail-text-muted mb-1 block">Backup frequency</label>
              <select
                value={backupGlobalConfig.interval}
                onChange={(e) => setBackupGlobalConfig({ interval: e.target.value })}
                className={selectClass}
              >
                <option value="hourly">Every hour (when idle)</option>
                <option value="daily">Once a day (when idle)</option>
                <option value="weekly">Once a week (when idle)</option>
              </select>
            </div>
          </div>
        )}

        {/* Back up all now button + live progress */}
        <div className={`${backupGlobalEnabled ? 'pt-3 border-t border-mail-border mt-3' : 'pt-3'} space-y-2`}>
          {activeBackup && activeBackup.active && (
            <div className="bg-mail-bg rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Loader size={14} className="text-mail-accent animate-spin flex-shrink-0" />
                <span className="text-xs font-semibold text-mail-text truncate">
                  Backing up {activeBackup.accountEmail}
                </span>
                {activeBackup.queueLength > 0 && (
                  <span className="text-xs text-mail-text-muted">+{activeBackup.queueLength} queued</span>
                )}
              </div>
              <div className="flex items-center justify-between text-xs text-mail-text-muted">
                <span>{activeBackup.folder || 'Starting...'} {activeBackup.totalFolders > 0 && `(${activeBackup.completedFolders}/${activeBackup.totalFolders})`}</span>
                <span>{activeBackup.completedEmails > 0 && `${activeBackup.completedEmails} emails`}</span>
              </div>
              {activeBackup.totalFolders > 0 && (
                <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
                  <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${Math.round((activeBackup.completedFolders / activeBackup.totalFolders) * 100)}%` }} />
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => {
              console.log('[backup] Back up all clicked, queuing', visibleAccounts.length, 'accounts');
              for (const account of visibleAccounts) {
                backupScheduler.triggerManualBackup(account.id);
              }
            }}
            disabled={activeBackup?.active}
            className="w-full bg-mail-accent/10 text-mail-accent rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-mail-accent/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {activeBackup?.active ? (
              <>
                <Loader size={16} className="animate-spin" />
                Backup in progress...
              </>
            ) : (
              <>
                <HardDrive size={16} />
                Back up all accounts now
              </>
            )}
          </button>
        </div>
      </div>

      {/* Per-Account Cards */}
      {visibleAccounts.length > 0 ? (
        visibleAccounts.map(account => (
          <AccountCard
            key={account.id}
            ref={el => { cardRefs.current[account.id] = el; }}
            account={account}
            isPaidUser={isPaidUser}
            globalEnabled={backupGlobalEnabled}
            highlighted={highlightedId === account.id}
            onUpgrade={onUpgrade}
          />
        ))
      ) : (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5 text-center">
          <h4 className="font-semibold text-mail-text mb-2">No accounts configured</h4>
          <p className="text-sm text-mail-text-muted">
            Add an email account first, then configure backup schedules.
          </p>
        </div>
      )}

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
