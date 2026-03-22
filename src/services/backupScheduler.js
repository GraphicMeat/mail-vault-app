import * as api from './api';
import { useSettingsStore } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { ensureFreshToken, hasValidCredentials } from './authUtils';

const RETRY_DELAYS = [30_000, 120_000, 300_000]; // 30s, 2min, 5min

class BackupScheduler {
  constructor() {
    this._timers = new Map();      // accountId -> timeoutId
    this._running = new Map();     // accountId -> boolean
    this._retryCount = new Map();  // accountId -> number
    this._queue = [];              // sequential backup queue
    this._queueRunning = false;    // true when processing queue
  }

  _getEffectiveConfig(accountId) {
    const state = useSettingsStore.getState();
    if (state.backupGlobalEnabled) {
      return { ...state.backupGlobalConfig, enabled: true };
    }
    return state.backupSchedules[accountId];
  }

  startSchedule(accountId) {
    this.stopSchedule(accountId);
    const config = this._getEffectiveConfig(accountId);
    if (!config?.enabled) return;

    // Run immediately on first enable
    this._executeBackup(accountId);

    // Schedule recurring using setTimeout chain (not setInterval -- avoids drift)
    this._scheduleNext(accountId);
  }

  stopSchedule(accountId) {
    const timer = this._timers.get(accountId);
    if (timer) clearTimeout(timer);
    this._timers.delete(accountId);
    this._retryCount.delete(accountId);
  }

  stopAll() {
    for (const accountId of this._timers.keys()) {
      this.stopSchedule(accountId);
    }
  }

  isRunning(accountId) {
    return this._running.get(accountId) || false;
  }

  /**
   * Check all accounts for overdue backups (e.g. after wake from sleep).
   * JS setTimeout pauses during sleep — if nextRunTime has passed, run immediately.
   */
  checkOverdue() {
    const state = useSettingsStore.getState();
    const accounts = useMailStore.getState().accounts || [];
    const { backupGlobalEnabled, backupSchedules, hiddenAccounts, backupState } = state;

    for (const account of accounts) {
      if (hiddenAccounts?.[account.id]) continue;

      const config = this._getEffectiveConfig(account.id);
      if (!config?.enabled) continue;

      if (this._running.get(account.id)) continue;

      const accountState = backupState[account.id];
      const nextRun = accountState?.nextRunTime;

      // Overdue: nextRunTime has passed, or no nextRunTime set (never scheduled / app restart)
      if (!nextRun || Date.now() > nextRun) {
        console.log(`[backup] Overdue backup detected for ${account.email} (next was ${nextRun ? new Date(nextRun).toLocaleTimeString() : 'unset'}) — queuing now`);
        this._executeBackup(account.id);
        this._scheduleNext(account.id);
      }
    }
  }

  _scheduleNext(accountId) {
    const config = this._getEffectiveConfig(accountId);
    if (!config?.enabled) return;

    const delay = this._computeDelay(config);
    const timerId = setTimeout(() => {
      this._executeBackup(accountId);
      this._scheduleNext(accountId); // chain next run
    }, delay);
    this._timers.set(accountId, timerId);

    // Store next run time for UI display
    useSettingsStore.getState().updateBackupState(accountId, {
      nextRunTime: Date.now() + delay
    });
  }

  _computeDelay(config) {
    if (config.interval === 'hourly') {
      return (config.hourlyInterval || 1) * 3600_000;
    }
    // Daily/Weekly: compute ms until next target time
    const now = new Date();
    const [hours, minutes] = (config.timeOfDay || '03:00').split(':').map(Number);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target <= now) target.setDate(target.getDate() + 1);

    if (config.interval === 'weekly' && config.dayOfWeek !== undefined) {
      while (target.getDay() !== config.dayOfWeek) {
        target.setDate(target.getDate() + 1);
      }
    }

    return target.getTime() - now.getTime();
  }

  // Queue a backup — accounts run one at a time to avoid overwhelming network/servers
  async _executeBackup(accountId) {
    if (this._running.get(accountId)) return;
    // Don't queue duplicates
    if (this._queue.some(id => id === accountId)) return;

    this._queue.push(accountId);
    this._processQueue();
  }

  async _processQueue() {
    if (this._queueRunning || this._queue.length === 0) return;
    this._queueRunning = true;

    while (this._queue.length > 0) {
      const accountId = this._queue.shift();
      if (this._running.get(accountId)) continue;
      await this._runBackup(accountId);
    }

    this._queueRunning = false;
  }

  async _runBackup(accountId) {
    this._running.set(accountId, true);

    const accounts = useMailStore.getState().accounts || [];
    let account = accounts.find(a => a.id === accountId);
    if (!account) {
      this._running.set(accountId, false);
      return;
    }

    // Show active backup in UI
    useSettingsStore.getState().setActiveBackup({
      accountId,
      accountEmail: account.email,
      folder: 'Starting...',
      totalFolders: 0,
      completedFolders: 0,
      completedEmails: 0,
      active: true,
      queueLength: this._queue.length,
    });

    if (!hasValidCredentials(account)) {
      console.warn(`[backup] Skipping ${account.email} — no valid credentials`);
      useSettingsStore.getState().updateBackupState(accountId, {
        lastStatus: 'failed',
        lastError: 'Missing credentials — re-enter password in Settings > Accounts',
      });
      this._running.set(accountId, false);
      return;
    }

    try {
      // Refresh OAuth2 token before backup (will be re-refreshed between folders by Rust)
      const freshAccount = await ensureFreshToken(account);

      const startTime = Date.now();
      const customPath = useSettingsStore.getState().backupCustomPath || null;
      const result = await api.backupRunAccount(accountId, JSON.stringify(freshAccount), customPath);

      const entry = {
        timestamp: Date.now(),
        emailsBackedUp: result.emails_backed_up || 0,
        durationSecs: result.duration_secs || ((Date.now() - startTime) / 1000),
        success: result.success !== false,
        error: result.error_message || null
      };

      const storeNow = useSettingsStore.getState();
      storeNow.addBackupHistoryEntry(accountId, entry);
      storeNow.updateBackupState(accountId, {
        lastBackupTime: Date.now(),
        lastStatus: entry.success ? 'success' : 'failed',
        lastError: entry.error,
        emailsBackedUp: (storeNow.backupState[accountId]?.emailsBackedUp || 0) + entry.emailsBackedUp
      });

      // Send notification
      if (entry.success && storeNow.backupNotifyOnSuccess) {
        api.sendNotification(
          `Backup complete - ${account.email}`,
          `${entry.emailsBackedUp} new emails backed up.`
        ).catch(() => {});
      } else if (!entry.success && storeNow.backupNotifyOnFailure) {
        api.sendNotification(
          `Backup failed - ${account.email}`,
          `${entry.error || 'Unknown error'}. Will retry automatically.`
        ).catch(() => {});
      }

      this._retryCount.delete(accountId); // reset on success
    } catch (err) {
      console.error(`[BackupScheduler] Backup failed for ${accountId}:`, err);
      const retries = this._retryCount.get(accountId) || 0;
      if (retries < 3) {
        this._retryCount.set(accountId, retries + 1);
        const delay = RETRY_DELAYS[retries];
        console.warn(`[BackupScheduler] Retry ${retries + 1}/3 for ${accountId} in ${delay / 1000}s`);
        setTimeout(() => this._runBackup(accountId), delay);
      } else {
        // Give up until next scheduled run
        const storeNow = useSettingsStore.getState();
        storeNow.updateBackupState(accountId, {
          lastBackupTime: Date.now(),
          lastStatus: 'failed',
          lastError: err.message || String(err)
        });
        storeNow.addBackupHistoryEntry(accountId, {
          timestamp: Date.now(),
          emailsBackedUp: 0,
          durationSecs: 0,
          success: false,
          error: err.message || String(err)
        });
        if (storeNow.backupNotifyOnFailure) {
          api.sendNotification(
            `Backup failed - ${account.email}`,
            `${err.message || 'Unknown error'}. Will retry on next schedule.`
          ).catch(() => {});
        }
        this._retryCount.delete(accountId);
      }
    } finally {
      this._running.set(accountId, false);
      // Clear active backup or show next queued account
      if (this._queue.length > 0) {
        const nextId = this._queue[0];
        const nextAcc = (useMailStore.getState().accounts || []).find(a => a.id === nextId);
        useSettingsStore.getState().setActiveBackup({
          accountId: nextId, accountEmail: nextAcc?.email || nextId,
          folder: 'Queued...', totalFolders: 0, completedFolders: 0, completedEmails: 0,
          active: true, queueLength: this._queue.length,
        });
      } else {
        useSettingsStore.getState().clearActiveBackup();
      }
    }
  }

  /** Trigger manual backup (for "Back up now" button) */
  async triggerManualBackup(accountId) {
    return this._executeBackup(accountId);
  }

  /** Start listening to backup-progress Tauri events for live toast updates */
  async initProgressListener() {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('backup-progress', (event) => {
        const p = event.payload;
        const current = useSettingsStore.getState().activeBackup;
        if (current && current.accountId === p.account_id) {
          useSettingsStore.getState().setActiveBackup({
            ...current,
            folder: p.folder,
            totalFolders: p.total_folders,
            completedFolders: p.completed_folders,
            completedEmails: p.completed_emails,
            active: p.active,
          });
        }
      });
    } catch {}
  }
}

export const backupScheduler = new BackupScheduler();
