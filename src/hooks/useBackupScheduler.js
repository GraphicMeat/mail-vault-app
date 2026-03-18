import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { backupScheduler } from '../services/backupScheduler';

/**
 * React hook that bridges the backupScheduler singleton to component lifecycle.
 * Watches backupSchedules config and starts/stops schedules accordingly.
 * Follows the same pattern as usePipelineCoordinator.
 */
export function useBackupScheduler() {
  const accounts = useSettingsStore(s => s.accounts);
  const backupSchedules = useSettingsStore(s => s.backupSchedules);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const prevSchedulesRef = useRef(null);

  useEffect(() => {
    const prev = prevSchedulesRef.current;
    prevSchedulesRef.current = backupSchedules;

    if (!accounts?.length) return;

    // Start/stop schedules based on config changes
    for (const account of accounts) {
      if (hiddenAccounts?.[account.id]) continue;
      const config = backupSchedules[account.id];
      const prevConfig = prev?.[account.id];

      if (config?.enabled && JSON.stringify(config) !== JSON.stringify(prevConfig)) {
        backupScheduler.startSchedule(account.id);
      } else if (!config?.enabled && prevConfig?.enabled) {
        backupScheduler.stopSchedule(account.id);
      }
    }

    return () => {
      backupScheduler.stopAll();
    };
  }, [accounts, backupSchedules, hiddenAccounts]);
}
