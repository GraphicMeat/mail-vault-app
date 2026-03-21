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

      const accountState = backupState[account.id];
      if (!accountState?.nextRunTime) continue;

      if (Date.now() > accountState.nextRunTime && !this._running.get(account.id)) {
        console.log(`[backup] Overdue backup detected for ${account.email} — running now`);
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

  async _executeBackup(accountId) {
    if (this._running.get(accountId)) return; // prevent concurrent runs
    this._running.set(accountId, true);

    const accounts = useMailStore.getState().accounts || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      this._running.set(accountId, false);
      return;
    }

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
      // Refresh OAuth2 token before backup
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
        setTimeout(() => this._executeBackup(accountId), delay);
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
    }
  }

  /** Trigger manual backup (for "Back up now" button) */
  async triggerManualBackup(accountId) {
    return this._executeBackup(accountId);
  }
}

export const backupScheduler = new BackupScheduler();
