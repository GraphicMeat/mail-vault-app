import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { backupScheduler } from '../services/backupScheduler';

/**
 * React hook that bridges the backupScheduler singleton to component lifecycle.
 * Watches backupSchedules config and starts/stops schedules accordingly.
 * Supports global backup mode: when backupGlobalEnabled=true, all visible accounts
 * use the global config. Per-account overrides still apply when global is off.
 */
export function useBackupScheduler() {
  const accounts = useSettingsStore(s => s.accounts);
  const backupSchedules = useSettingsStore(s => s.backupSchedules);
  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const prevRef = useRef(null);

  useEffect(() => {
    const prevKey = prevRef.current;
    const currentKey = JSON.stringify({ backupSchedules, backupGlobalEnabled, backupGlobalConfig });
    prevRef.current = currentKey;

    if (!accounts?.length) return;

    for (const account of accounts) {
      if (hiddenAccounts?.[account.id]) continue;

      let shouldRun = false;
      if (backupGlobalEnabled) {
        // Global mode: all visible accounts use global config
        shouldRun = true;
      } else {
        // Per-account mode
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
}
