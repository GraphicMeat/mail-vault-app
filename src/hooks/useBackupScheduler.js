import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { backupScheduler } from '../services/backupScheduler';

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes of no user activity
const IDLE_CHECK_INTERVAL_MS = 30_000;    // Check every 30 seconds
const MIN_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // Don't re-backup within 1 hour

/**
 * Idle-based backup scheduler.
 * Backups trigger when the user is idle for 3+ minutes and a backup is due.
 * Also triggers after wake from sleep (with 10s delay for network recovery).
 */
export function useBackupScheduler() {
  const lastActivityRef = useRef(Date.now());
  const checkingRef = useRef(false);

  useEffect(() => {
    const markActive = () => { lastActivityRef.current = Date.now(); };
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(e => document.addEventListener(e, markActive, { passive: true }));

    // Init progress event listener
    backupScheduler.initProgressListener();

    // Periodic idle check
    const interval = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs >= IDLE_THRESHOLD_MS && !checkingRef.current) {
        checkingRef.current = true;
        checkAndRunBackups();
        checkingRef.current = false;
      }
    }, IDLE_CHECK_INTERVAL_MS);

    // Wake-from-sleep detector — if heartbeat gap > 30s, machine was asleep
    let lastTick = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 30_000) {
        console.log(`[backup] Wake detected (${Math.round(gap / 1000)}s gap) — checking backups in 10s`);
        // Wait 10s for network to reconnect, then check for due backups
        setTimeout(() => {
          console.log('[backup] Post-wake backup check running');
          checkAndRunBackups();
        }, 10_000);
      }
    }, 15_000);

    // Also check on visibility change (user switches back to app)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        setTimeout(() => checkAndRunBackups(), 5000);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      events.forEach(e => document.removeEventListener(e, markActive));
      clearInterval(interval);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', handleVisibility);
      backupScheduler.stopAll();
    };
  }, []);
}

/**
 * Check all enabled accounts and queue backups for those that are due.
 */
function checkAndRunBackups() {
  const settings = useSettingsStore.getState();
  const accounts = useMailStore.getState().accounts || [];
  const { backupGlobalEnabled, backupGlobalConfig, backupSchedules, hiddenAccounts, backupState } = settings;

  if (accounts.length === 0) {
    console.log('[backup] No accounts loaded yet — skipping check');
    return;
  }

  let queued = 0;

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
    const lastBackup = accountState?.lastBackupTime || 0;
    const intervalMs = getIntervalMs(config);
    const timeSinceLastBackup = Date.now() - lastBackup;

    if (timeSinceLastBackup >= intervalMs && timeSinceLastBackup >= MIN_BACKUP_INTERVAL_MS) {
      console.log(`[backup] ${account.email} is due (last: ${lastBackup ? new Date(lastBackup).toLocaleString() : 'never'}, interval: ${Math.round(intervalMs / 3600000)}h)`);
      backupScheduler.queueBackup(account.id);
      queued++;
    }
  }

  if (queued > 0) {
    console.log(`[backup] Queued ${queued} account(s) for backup`);
  }
}

function getIntervalMs(config) {
  if (config.interval === 'hourly') return (config.hourlyInterval || 1) * 3600_000;
  if (config.interval === 'weekly') return 7 * 24 * 3600_000;
  return 24 * 3600_000; // daily default
}
