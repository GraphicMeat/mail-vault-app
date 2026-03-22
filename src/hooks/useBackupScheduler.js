import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { backupScheduler } from '../services/backupScheduler';

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes of no user activity
const IDLE_CHECK_INTERVAL_MS = 30_000;    // Check every 30 seconds
const MIN_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // Don't re-backup within 1 hour

/**
 * Idle-based backup scheduler.
 * Instead of fixed timers, backups trigger when the user is idle for 3+ minutes
 * and a backup is due (last backup was more than the configured interval ago).
 * Accounts back up sequentially, one at a time.
 */
export function useBackupScheduler() {
  const lastActivityRef = useRef(Date.now());
  const checkingRef = useRef(false);

  // Track user activity
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

    // Also check after wake from sleep (heartbeat gap detection)
    let lastTick = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 30_000) {
        console.log(`[backup] Wake detected (${Math.round(gap / 1000)}s gap) — will check on idle`);
        // Don't run immediately on wake — wait for idle
      }
    }, 15_000);

    return () => {
      events.forEach(e => document.removeEventListener(e, markActive));
      clearInterval(interval);
      clearInterval(heartbeat);
      backupScheduler.stopAll();
    };
  }, []);
}

/**
 * Check all enabled accounts and queue backups for those that are due.
 * "Due" means: last backup was longer ago than the configured interval,
 * or never backed up at all.
 */
function checkAndRunBackups() {
  const state = useSettingsStore.getState();
  const accounts = state.accounts || [];
  const { backupGlobalEnabled, backupGlobalConfig, backupSchedules, hiddenAccounts, backupState } = state;

  let queued = 0;

  for (const account of accounts) {
    if (hiddenAccounts?.[account.id]) continue;

    // Check if backup is enabled for this account
    let config;
    if (backupGlobalEnabled) {
      config = { ...backupGlobalConfig, enabled: true };
    } else {
      config = backupSchedules[account.id];
    }
    if (!config?.enabled) continue;

    // Check if backup is due
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
    console.log(`[backup] Queued ${queued} account(s) for idle backup`);
  }
}

function getIntervalMs(config) {
  if (config.interval === 'hourly') return (config.hourlyInterval || 1) * 3600_000;
  if (config.interval === 'weekly') return 7 * 24 * 3600_000;
  return 24 * 3600_000; // daily default
}
