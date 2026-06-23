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

  // Share-to-unlock prompt trigger. Set after an eligible successful backup;
  // ShareUnlockModal renders while non-null. { emailsBackedUp } | null
  shareUnlock: null,
  setShareUnlock: (payload) => set({ shareUnlock: payload }),
  clearShareUnlock: () => set({ shareUnlock: null }),
}));
