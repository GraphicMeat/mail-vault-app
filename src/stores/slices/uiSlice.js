// ── uiSlice — view mode, progress indicators, error state ──

import * as db from '../../services/db';
import { useSettingsStore } from '../settingsStore';
import { getAccountCacheMailboxes as _getAccountMailboxes } from '../../services/cacheManager';
import { _resolveMailboxPath } from './unifiedHelpers';

export const createUiSlice = (set, get) => ({
  // View mode: 'all' | 'server' | 'local'
  viewMode: 'all',

  // Incremented on flag changes (read/unread) — allows thread caches to invalidate
  _flagSeq: 0,

  // Pre-sorted emails fingerprint for memoization
  _sortedEmailsFingerprint: '',

  // Bulk save progress
  bulkSaveProgress: null, // { total, completed, errors, active }
  exportProgress: null, // { total, completed, active, mode: 'export'|'import' }

  // Error state
  error: null,

  // View mode — refresh local state from disk when switching to local view
  // so that in-progress bulk saves are reflected immediately
  setViewMode: (mode) => {
    set({ viewMode: mode });
    get().updateSortedEmails();
    if (mode === 'server') {
      // If emails array is empty (account just switched, IMAP not yet synced), trigger load
      if (get().emails.length === 0) {
        get().loadEmails();
      }
    } else if (mode === 'local' || mode === 'all') {
      // Refresh local state in background for up-to-date archive data
      if (get().unifiedInbox) {
        // Unified mode: refresh local data for all accounts using resolved folder paths
        const { accounts, unifiedFolder } = get();
        const targetFolder = unifiedFolder || 'INBOX';
        const { hiddenAccounts } = useSettingsStore.getState();
        const allLocalEmails = [];
        const allSavedIds = new Set();
        const allArchivedIds = new Set();
        Promise.all(
          accounts.filter(a => !hiddenAccounts[a.id]).map(async (account) => {
            try {
              // Resolve provider-specific folder path (e.g. "[Gmail]/Sent Mail" for "Sent")
              let mailboxes = _getAccountMailboxes(account.id);
              if (!mailboxes?.length) mailboxes = await db.getCachedMailboxes(account.id);
              const localFolder = _resolveMailboxPath(mailboxes || [], targetFolder);
              const [saved, archived] = await Promise.all([
                db.getSavedEmailIds(account.id, localFolder),
                db.getArchivedEmailIds(account.id, localFolder),
              ]);
              let locals = await db.readLocalEmailIndex(account.id, localFolder);
              if (!locals) locals = await db.getLocalEmails(account.id, localFolder);
              for (const uid of saved) allSavedIds.add(uid);
              for (const uid of archived) allArchivedIds.add(uid);
              for (const e of locals) {
                allLocalEmails.push({ ...e, _accountEmail: account.email, _accountId: account.id, _mailbox: localFolder });
              }
            } catch {}
          })
        ).then(() => {
          set({ savedEmailIds: allSavedIds, archivedEmailIds: allArchivedIds, localEmails: allLocalEmails });
          get().updateSortedEmails();
        });
      } else {
        const { activeAccountId, activeMailbox } = get();
        if (activeAccountId && activeMailbox) {
          (async () => {
            const [savedEmailIds, archivedEmailIds] = await Promise.all([
              db.getSavedEmailIds(activeAccountId, activeMailbox),
              db.getArchivedEmailIds(activeAccountId, activeMailbox),
            ]);
            let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox);
            if (!localEmails) localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
            set({ savedEmailIds, archivedEmailIds, localEmails });
            get().updateSortedEmails();
          })();
        }
      }
    }
  },

  setExportProgress: (progress) => {
    set({ exportProgress: progress });
  },
  dismissExportProgress: () => {
    set({ exportProgress: null });
  },
  dismissBulkProgress: () => {
    set({ bulkSaveProgress: null });
  },

  // Clear error
  clearError: () => set({ error: null }),
});
