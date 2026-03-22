import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { backupScheduler } from '../services/backupScheduler';

/**
 * React hook that bridges the backupScheduler singleton to component lifecycle.
 * Watches backupSchedules config and starts/stops schedules accordingly.
 * Supports global backup mode: when backupGlobalEnabled=true, all visible accounts
 * use the global config. Per-account overrides still apply when global is off.
 *
 * Also detects wake from sleep via a heartbeat timer — if the timer fires late
 * (gap > 30s), the machine was asleep. Runs overdue backups immediately.
 */
export function useBackupScheduler() {
  const accounts = useSettingsStore(s => s.accounts);
  const backupSchedules = useSettingsStore(s => s.backupSchedules);
  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const prevRef = useRef(null);

  // Schedule management — start/stop based on config changes
  useEffect(() => {
    const prevKey = prevRef.current;
    const currentKey = JSON.stringify({ backupSchedules, backupGlobalEnabled, backupGlobalConfig });
    prevRef.current = currentKey;

    if (!accounts?.length) return;

    for (const account of accounts) {
      if (hiddenAccounts?.[account.id]) continue;

      let shouldRun = false;
      if (backupGlobalEnabled) {
        shouldRun = true;
      } else {
        const config = backupSchedules[account.id];
        shouldRun = config?.enabled;
      }

      if (shouldRun && prevKey !== currentKey) {
        backupScheduler.startSchedule(account.id);
      } else if (!shouldRun) {
        backupScheduler.stopSchedule(account.id);
      }
    }

    return () => {
      backupScheduler.stopAll();
    };
  }, [accounts, backupSchedules, backupGlobalEnabled, backupGlobalConfig, hiddenAccounts]);

  // Wake-from-sleep detector — heartbeat every 15s, if gap > 30s we were asleep
  useEffect(() => {
    // Start listening to backup-progress events for toast
    backupScheduler.initProgressListener();

    let lastTick = Date.now();

    const heartbeat = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;

      // If more than 30 seconds passed since last tick, machine was likely asleep
      if (gap > 30_000) {
        console.log(`[backup] Wake detected (${Math.round(gap / 1000)}s gap) — checking overdue backups`);
        backupScheduler.checkOverdue();
      }
    }, 15_000);

    // Also check on visibility change (user switches back to app)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        backupScheduler.checkOverdue();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}
