import * as api from './api';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useBackupStore } from '../stores/backupStore';
import { useMailStore } from '../stores/mailStore';
import { hasValidCredentials, resolveServerAccount } from './authUtils';
import { createSnapshotFromMaildir } from './snapshotService';

const RETRY_DELAYS = [30_000, 120_000, 300_000]; // 30s, 2min, 5min

/**
 * Lifecycle states for the backup coordinator.
 * Only 'idle' and 'running' allow new work to start.
 * Paused states block queue processing until resumed.
 */
export const State = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED_SLEEP: 'paused_sleep',
  PAUSED_OFFLINE: 'paused_offline',
  PAUSED_USER_ACTIVE: 'paused_user_active',
};

class BackupCoordinator {
  constructor() {
    this._state = State.IDLE;
    this._running = new Map();       // accountId -> boolean
    this._retryCount = new Map();    // accountId -> number
    this._queue = [];                // sequential backup queue
    this._queueRunning = false;
    this._pausedAccountId = null;    // account that was interrupted by pause
    this._checkpoints = new Map();   // accountId -> completedFolders (resume position)
    this._manualIds = new Set();     // accounts triggered manually (bypass gates)
    this._manualResolvers = new Map(); // accountId -> { resolve } for triggerManualBackup promise
  }

  // ── Lifecycle transitions ──────────────────────────────────────────────

  get state() { return this._state; }

  /** Called by hook when user becomes idle */
  onUserIdle() {
    if (this._state === State.PAUSED_USER_ACTIVE) {
      console.log('[backup] User idle — resuming coordinator');
      this._state = State.IDLE;
      this._resumeInterrupted();
      this._scheduleCheck();
    }
  }

  /** Called by hook when user becomes active while backup is running */
  onUserActive() {
    // Only pause automatic backups, not manual ones
    if (this._state === State.RUNNING && !this._isCurrentManual()) {
      console.log('[backup] User active — pausing automatic backup');
      this._state = State.PAUSED_USER_ACTIVE;
      this._pauseCurrentBackup();
    }
  }

  /** Called by hook on sleep detection (heartbeat gap) */
  onSleep() {
    if (this._state === State.RUNNING || this._state === State.IDLE) {
      console.log('[backup] Sleep detected — pausing coordinator');
      this._state = State.PAUSED_SLEEP;
      if (this._hasActiveWork()) this._pauseCurrentBackup();
    }
  }

  /** Called by hook after wake (with delay for network recovery) */
  onWake() {
    if (this._state === State.PAUSED_SLEEP) {
      console.log('[backup] Wake detected — resuming coordinator');
      this._state = State.IDLE;
      // Re-queue the interrupted account if any
      this._resumeInterrupted();
      this._scheduleCheck();
    }
  }

  /** Called by hook on navigator.onLine change */
  onOnline() {
    if (this._state === State.PAUSED_OFFLINE) {
      console.log('[backup] Online — resuming coordinator');
      this._state = State.IDLE;
      this._resumeInterrupted();
      this._scheduleCheck();
    }
  }

  onOffline() {
    if (this._state === State.RUNNING || this._state === State.IDLE) {
      console.log('[backup] Offline — pausing coordinator');
      this._state = State.PAUSED_OFFLINE;
      if (this._hasActiveWork()) this._pauseCurrentBackup();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Queue automatic backup for an account (called by idle check) */
  queueBackup(accountId) {
    if (this._running.get(accountId)) return;
    if (this._queue.includes(accountId)) return;
    this._queue.push(accountId);
    this._processQueue();
  }

  /** Trigger manual backup — bypasses idle/lifecycle gates.
   *  Returns a promise that resolves with { status, message? } when the backup completes.
   *  status: 'success' | 'failed' | 'cancelled' | 'skipped_credentials'
   */
  triggerManualBackup(accountId) {
    return new Promise((resolve) => {
      this._manualResolvers.set(accountId, { resolve });
      this._manualIds.add(accountId);
      this.queueBackup(accountId);
    });
  }

  /** Full stop — cancel active backup and clear queue */
  stopAll() {
    this._queue = [];
    this._manualIds.clear();
    this._checkpoints.clear();
    if (this._hasActiveWork()) {
      api.backupCancel().catch(() => {});
    }
  }

  isRunning(accountId) {
    return this._running.get(accountId) || false;
  }

  /**
   * Check all enabled accounts and queue those that are due.
   * Called by the hook on idle / wake / visibility.
   */
  checkAndQueueDue() {
    if (this._isPaused()) return;

    const settings = useSettingsStore.getState();
    const mailState = useMailStore.getState();
    const accounts = mailState.accounts || [];
    const { backupGlobalEnabled, backupGlobalConfig, backupSchedules, hiddenAccounts, backupState } = settings;

    if (accounts.length === 0) return;

    // Gate: don't start automatic backups while mail is loading
    if (mailState.loading) {
      console.log('[backup] Mail loading — deferring backup check');
      return;
    }

    let queued = 0;
    const now = Date.now();

    for (const account of accounts) {
      if (hiddenAccounts?.[account.id]) continue;

      let config;
      if (backupGlobalEnabled) {
        config = { ...backupGlobalConfig, enabled: true };
      } else {
        config = backupSchedules[account.id];
      }
      if (!config?.enabled) continue;

      const accountState = backupState[account.id];
      const nextEligible = computeNextEligibleTime(accountState, config);

      if (now >= nextEligible) {
        console.log(`[backup] ${account.email} is due (next eligible: ${new Date(nextEligible).toLocaleString()})`);
        this.queueBackup(account.id);
        queued++;
      }
    }

    if (queued > 0) {
      console.log(`[backup] Queued ${queued} account(s) for backup`);
    }
  }

  // ── Queue processing ───────────────────────────────────────────────────

  async _processQueue() {
    if (this._queueRunning || this._queue.length === 0) return;

    // Don't process if paused (unless there are manual backups in the queue)
    if (this._isPaused() && !this._hasManualInQueue()) return;

    this._queueRunning = true;

    while (this._queue.length > 0) {
      const isManualNext = this._manualIds.has(this._queue[0]);

      // Check gates before each account
      if (this._isPaused() && !isManualNext) {
        // Paused and next item is automatic — stop processing
        break;
      }

      const accountId = this._queue.shift();
      if (this._running.get(accountId)) continue;

      // Save paused state before manual backup — restore it afterward
      // so automatic items remain blocked by the original pause reason
      const savedState = this._isPaused() ? this._state : null;

      this._state = State.RUNNING;
      await this._runBackup(accountId);

      // Restore paused state if we were running a manual job through a pause gate
      if (savedState && !this._isPaused()) {
        this._state = savedState;
      }

      // After each backup, check if we should continue
      if (this._isPaused()) break;
    }

    this._queueRunning = false;
    if (this._state === State.RUNNING) {
      this._state = State.IDLE;
    }
  }

  async _runBackup(accountId) {
    const isManual = this._manualIds.has(accountId);
    this._manualIds.delete(accountId);

    console.log(`[backup] _runBackup started for ${accountId} (${isManual ? 'manual' : 'automatic'})`);
    this._running.set(accountId, true);

    const accounts = useMailStore.getState().accounts || [];
    let account = accounts.find(a => a.id === accountId);
    if (!account) {
      console.warn(`[backup] Account ${accountId} not found — skipping`);
      this._running.set(accountId, false);
      this._resolveManual(accountId, { status: 'failed', message: 'Account not found' });
      return;
    }
    console.log(`[backup] Running backup for ${account.email}`);

    // Show active backup in ephemeral store (for sidebar indicator)
    useBackupStore.getState().setActiveBackup({
      accountId,
      accountEmail: account.email,
      folder: 'Starting...',
      totalFolders: 0,
      completedFolders: 0,
      completedEmails: 0,
      active: true,
      manual: isManual,
      queueLength: this._queue.length,
    });

    // Resolve fully credentialed account (keychain + token refresh)
    const resolved = await resolveServerAccount(accountId, account);
    if (!resolved.ok) {
      console.warn(`[backup] Skipping ${account.email} — ${resolved.message}`);
      const storeNow = useSettingsStore.getState();
      storeNow.updateBackupState(accountId, {
        lastStatus: 'failed',
        lastError: resolved.message,
      });
      // Record a failed history entry so the UI stays consistent
      storeNow.addBackupHistoryEntry(accountId, {
        timestamp: Date.now(),
        emailsBackedUp: 0,
        durationSecs: 0,
        success: false,
        error: resolved.message,
      });
      this._running.set(accountId, false);
      // Clear active progress without showing "Complete"
      useBackupStore.getState().clearActiveBackup();
      this._resolveManual(accountId, { status: 'failed_credentials', message: resolved.message });
      return;
    }

    try {
      const freshAccount = resolved.account;

      const startTime = Date.now();
      // External backup path resolved in Rust via bookmark/native access — pass null to use stored location
      const skipFolders = this._checkpoints.get(accountId) || 0;
      if (skipFolders > 0) {
        console.log(`[backup] Resuming ${account.email} from folder ${skipFolders}`);
      }
      const result = await api.backupRunAccount(accountId, JSON.stringify(freshAccount), null, skipFolders);

      // Track checkpoint for potential resume
      if (result.cancelled) {
        this._checkpoints.set(accountId, result.completed_folders || 0);
        console.log(`[backup] Cancelled ${account.email} at folder ${result.completed_folders} — checkpoint saved`);
        this._running.set(accountId, false);
        this._resolveManual(accountId, { status: 'cancelled' });
        return;
      }

      // Completed — clear checkpoint
      this._checkpoints.delete(accountId);

      const externalDegraded = result.external_copy_ok === false;
      const entry = {
        timestamp: Date.now(),
        emailsBackedUp: result.emails_backed_up || 0,
        durationSecs: result.duration_secs || ((Date.now() - startTime) / 1000),
        success: result.success !== false,
        error: result.error_message || null,
        externalCopyOk: result.external_copy_ok !== false,
        externalCopyError: result.external_copy_error || null,
        externalCopyFailedCount: result.external_copy_failed_count || 0,
      };

      const storeNow = useSettingsStore.getState();
      storeNow.addBackupHistoryEntry(accountId, entry);
      storeNow.updateBackupState(accountId, {
        lastBackupTime: Date.now(),
        lastStatus: entry.success ? (externalDegraded ? 'degraded' : 'success') : 'failed',
        lastError: entry.error || (externalDegraded ? result.external_copy_error : null),
        emailsBackedUp: (storeNow.backupState[accountId]?.emailsBackedUp || 0) + entry.emailsBackedUp
      });

      // Create Time Capsule snapshot after successful backup (premium only, respects cadence)
      if (entry.success && hasPremiumAccess(storeNow.billingProfile) && storeNow.snapshotAutoEnabled) {
        const cadence = storeNow.snapshotCadence || 'after_every_backup';
        const lastSnap = storeNow.snapshotLastTimes?.[accountId] || 0;
        const now = Date.now();
        const isDue = cadence === 'after_every_backup'
          || (cadence === 'daily' && now - lastSnap >= 86_400_000)
          || (cadence === 'weekly' && now - lastSnap >= 604_800_000);

        if (isDue) {
          createSnapshotFromMaildir(accountId, account.email)
            .then(() => storeNow.recordSnapshotTime(accountId))
            .catch(err => {
              console.warn(`[backup] Snapshot creation failed for ${account.email}:`, err.message);
            });
        }
      }

      // Send notification
      if (entry.success && !externalDegraded && storeNow.backupNotifyOnSuccess) {
        api.sendNotification(
          `Backup complete - ${account.email}`,
          `${entry.emailsBackedUp} new emails backed up.`
        ).catch(() => {});
      } else if (entry.success && externalDegraded && storeNow.backupNotifyOnFailure) {
        api.sendNotification(
          `Backup partially complete - ${account.email}`,
          `${entry.emailsBackedUp} emails backed up locally, but ${result.external_copy_failed_count || 'some'} failed to copy to external backup.`
        ).catch(() => {});
      } else if (!entry.success && storeNow.backupNotifyOnFailure) {
        api.sendNotification(
          `Backup failed - ${account.email}`,
          `${entry.error || 'Unknown error'}. Will retry on next idle.`
        ).catch(() => {});
      }

      this._retryCount.delete(accountId);
      this._resolveManual(accountId, {
        status: entry.success ? (externalDegraded ? 'degraded' : 'success') : 'failed',
        message: entry.error,
      });
    } catch (err) {
      console.error(`[backup] Backup failed for ${account.email}:`, err);

      // If we were paused (cancelled), don't count as a retry
      if (this._isPaused()) {
        console.log(`[backup] Backup interrupted by pause for ${account.email}`);
        this._pausedAccountId = accountId;
        this._running.set(accountId, false);
        this._resolveManual(accountId, { status: 'cancelled' });
        return;
      }

      // Manual backups: resolve immediately with failure (user is watching the button).
      // Automatic backups: retry up to 3 times with backoff.
      const hasManualResolver = this._manualResolvers.has(accountId);
      const retries = this._retryCount.get(accountId) || 0;
      if (!hasManualResolver && retries < 3) {
        this._retryCount.set(accountId, retries + 1);
        const delay = RETRY_DELAYS[retries];
        console.warn(`[backup] Retry ${retries + 1}/3 for ${account.email} — re-queuing in ${delay / 1000}s`);
        setTimeout(() => {
          this.queueBackup(accountId);
        }, delay);
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
        this._resolveManual(accountId, { status: 'failed', message: err.message || String(err) });
      }
    } finally {
      this._running.set(accountId, false);
      if (!this._isPaused()) {
        this._showNextOrDone();
      }
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  _isPaused() {
    return this._state === State.PAUSED_SLEEP
        || this._state === State.PAUSED_OFFLINE
        || this._state === State.PAUSED_USER_ACTIVE;
  }

  _hasActiveWork() {
    for (const [, running] of this._running) {
      if (running) return true;
    }
    return false;
  }

  _isCurrentManual() {
    const activeBackup = useBackupStore.getState().activeBackup;
    return activeBackup?.manual === true;
  }

  _hasManualInQueue() {
    return this._queue.some(id => this._manualIds.has(id));
  }

  /** Resolve the manual-backup promise for an account (if one exists). */
  _resolveManual(accountId, result) {
    const entry = this._manualResolvers.get(accountId);
    if (entry) {
      this._manualResolvers.delete(accountId);
      entry.resolve(result);
    }
  }

  _pauseCurrentBackup() {
    // Find the currently running account
    for (const [accountId, running] of this._running) {
      if (running) {
        this._pausedAccountId = accountId;
        break;
      }
    }
    // Cancel the Rust-side backup — it will cause the await in _runBackup to reject/return
    api.backupCancel().catch(() => {});
  }

  _resumeInterrupted() {
    if (this._pausedAccountId) {
      const accountId = this._pausedAccountId;
      this._pausedAccountId = null;
      // Re-queue at the front so it picks up where it left off (Rust backup is incremental)
      if (!this._queue.includes(accountId) && !this._running.get(accountId)) {
        this._queue.unshift(accountId);
        console.log(`[backup] Re-queued interrupted account ${accountId}`);
      }
    }
  }

  _scheduleCheck() {
    // Small delay to let state settle after wake/online/idle transitions
    setTimeout(() => this.checkAndQueueDue(), 2000);
  }

  _showNextOrDone() {
    if (this._queue.length > 0) {
      const nextId = this._queue[0];
      const nextAcc = (useMailStore.getState().accounts || []).find(a => a.id === nextId);
      useBackupStore.getState().setActiveBackup({
        accountId: nextId, accountEmail: nextAcc?.email || nextId,
        folder: 'Queued...', totalFolders: 0, completedFolders: 0, completedEmails: 0,
        active: true, queueLength: this._queue.length,
      });
    } else {
      // Show "Done" briefly before clearing
      const current = useBackupStore.getState().activeBackup;
      if (current) {
        useBackupStore.getState().setActiveBackup({
          ...current,
          folder: 'Complete',
          active: true,
          done: true,
          queueLength: 0,
        });
        setTimeout(() => {
          useBackupStore.getState().clearActiveBackup();
        }, 3000);
      } else {
        useBackupStore.getState().clearActiveBackup();
      }
    }
  }

  /** Start listening to backup-progress Tauri events for live UI updates */
  async initProgressListener() {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      let lastUpdate = 0;
      let pendingPayload = null;
      await listen('backup-progress', (event) => {
        pendingPayload = event.payload;
        const now = Date.now();
        // Throttle store updates to once per 2 seconds to avoid flooding re-renders
        if (now - lastUpdate < 2000) return;
        lastUpdate = now;
        const p = pendingPayload;
        const current = useBackupStore.getState().activeBackup;
        if (current && current.accountId === p.account_id) {
          useBackupStore.getState().setActiveBackup({
            ...current,
            folder: p.folder,
            totalFolders: p.total_folders,
            completedFolders: p.completed_folders,
            completedEmails: p.completed_emails,
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

// ── Scheduling logic ────────────────────────────────────────────────────────

const MIN_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // Never re-backup within 1 hour

/**
 * Compute the earliest time an account is eligible for its next backup.
 * Respects interval, timeOfDay, and dayOfWeek from config.
 */
export function computeNextEligibleTime(accountState, config) {
  const lastBackup = accountState?.lastBackupTime || 0;

  // Never backed up — eligible immediately
  if (lastBackup === 0) return 0;

  const intervalMs = getIntervalMs(config);

  // Base: lastBackup + interval
  let next = lastBackup + intervalMs;

  // For daily/weekly, align to configured timeOfDay
  if (config.interval === 'daily' || config.interval === 'weekly') {
    const timeOfDay = config.timeOfDay || '03:00';
    const [hours, minutes] = timeOfDay.split(':').map(Number);

    // Find the next occurrence of timeOfDay after lastBackup + interval
    const candidate = new Date(next);
    candidate.setHours(hours, minutes, 0, 0);

    // If the aligned time is before next (interval not yet elapsed), push to next day
    if (candidate.getTime() < next) {
      candidate.setDate(candidate.getDate() + 1);
    }

    // For weekly, advance to the correct day of week
    if (config.interval === 'weekly' && config.dayOfWeek != null) {
      const targetDay = config.dayOfWeek; // 0=Sun, 1=Mon, ...
      while (candidate.getDay() !== targetDay) {
        candidate.setDate(candidate.getDate() + 1);
      }
    }

    next = candidate.getTime();
  }

  // Enforce minimum interval
  return Math.max(next, lastBackup + MIN_BACKUP_INTERVAL_MS);
}

function getIntervalMs(config) {
  if (config.interval === 'hourly') return (config.hourlyInterval || 1) * 3600_000;
  if (config.interval === 'weekly') return 7 * 24 * 3600_000;
  return 24 * 3600_000; // daily default
}

export const backupScheduler = new BackupCoordinator();
