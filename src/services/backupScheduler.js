import * as api from './api';
import { useSettingsStore } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { ensureFreshToken, hasValidCredentials } from './authUtils';

const RETRY_DELAYS = [30_000, 120_000, 300_000]; // 30s, 2min, 5min

class BackupScheduler {
  constructor() {
    this._running = new Map();     // accountId -> boolean
    this._retryCount = new Map();  // accountId -> number
    this._queue = [];              // sequential backup queue
    this._queueRunning = false;
  }

  /** Queue a backup for an account (called by idle detector) */
  queueBackup(accountId) {
    if (this._running.get(accountId)) return;
    if (this._queue.includes(accountId)) return;
    this._queue.push(accountId);
    this._processQueue();
  }

  /** Trigger manual backup (for "Back up now" button) */
  triggerManualBackup(accountId) {
    this.queueBackup(accountId);
  }

  stopAll() {
    this._queue = [];
  }

  isRunning(accountId) {
    return this._running.get(accountId) || false;
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
    console.log(`[backup] _runBackup started for ${accountId}`);
    this._running.set(accountId, true);

    const accounts = useMailStore.getState().accounts || [];
    let account = accounts.find(a => a.id === accountId);
    if (!account) {
      console.warn(`[backup] Account ${accountId} not found — skipping`);
      this._running.set(accountId, false);
      return;
    }
    console.log(`[backup] Running backup for ${account.email}`);

    // Show active backup in store (for sidebar indicator)
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
      this._clearActiveOrShowNext();
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
          `${entry.error || 'Unknown error'}. Will retry on next idle.`
        ).catch(() => {});
      }

      this._retryCount.delete(accountId);
    } catch (err) {
      console.error(`[backup] Backup failed for ${account.email}:`, err);
      const retries = this._retryCount.get(accountId) || 0;
      if (retries < 3) {
        this._retryCount.set(accountId, retries + 1);
        const delay = RETRY_DELAYS[retries];
        console.warn(`[backup] Retry ${retries + 1}/3 for ${account.email} in ${delay / 1000}s`);
        setTimeout(() => this._runBackup(accountId), delay);
      } else {
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
            `${err.message || 'Unknown error'}. Will retry on next idle.`
          ).catch(() => {});
        }
        this._retryCount.delete(accountId);
      }
    } finally {
      this._running.set(accountId, false);
      this._clearActiveOrShowNext();
    }
  }

  _clearActiveOrShowNext() {
    if (this._queue.length > 0) {
      const nextId = this._queue[0];
      const nextAcc = (useMailStore.getState().accounts || []).find(a => a.id === nextId);
      useSettingsStore.getState().setActiveBackup({
        accountId: nextId, accountEmail: nextAcc?.email || nextId,
        folder: 'Queued...', totalFolders: 0, completedFolders: 0, completedEmails: 0,
        active: true, queueLength: this._queue.length,
      });
    } else {
      // Show "Done" briefly before clearing
      const current = useSettingsStore.getState().activeBackup;
      if (current) {
        useSettingsStore.getState().setActiveBackup({
          ...current,
          folder: 'Complete',
          active: true,
          done: true,
          queueLength: 0,
        });
        setTimeout(() => {
          useSettingsStore.getState().clearActiveBackup();
        }, 3000);
      } else {
        useSettingsStore.getState().clearActiveBackup();
      }
    }
  }

  /** Start listening to backup-progress Tauri events for live UI updates */
  async initProgressListener() {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('backup-progress', (event) => {
        const p = event.payload;
        const current = useSettingsStore.getState().activeBackup;
        if (current && current.accountId === p.account_id) {
          // Don't let Rust's active:false clear the UI — _runBackup's finally block handles that
          useSettingsStore.getState().setActiveBackup({
            ...current,
            folder: p.folder,
            totalFolders: p.total_folders,
            completedFolders: p.completed_folders,
            completedEmails: p.completed_emails,
            // Keep active=true as long as _runBackup is running
            active: true,
          });
        }
      });
      console.log('[backup] Progress listener initialized');
    } catch (e) {
      console.warn('[backup] Failed to init progress listener:', e);
    }
  }
}

export const backupScheduler = new BackupScheduler();
