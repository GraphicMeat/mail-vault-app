import { create } from 'zustand';

/**
 * Ephemeral (non-persisted) store for live backup progress.
 * Kept separate from settingsStore to avoid triggering JSON persistence
 * on every high-frequency progress update during backups.
 */
export const useBackupStore = create((set) => ({
  // Active backup progress (for toast / sidebar display)
  activeBackup: null, // { accountId, accountEmail, folder, totalFolders, completedFolders, completedEmails, active, done, queueLength }
  setActiveBackup: (backup) => set({ activeBackup: backup }),
  clearActiveBackup: () => set({ activeBackup: null }),
}));
