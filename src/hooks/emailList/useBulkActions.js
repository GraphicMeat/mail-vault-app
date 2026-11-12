import { useT } from '../../i18n/index.js';
import { useEffect, useState } from 'react';
import { bulkOperationManager } from '../../services/BulkOperationManager';
import { useMailStore } from '../../stores/mailStore';
import { captureBulkScope } from '../../services/bulkSelection.js';
import { archivedSelectionKeys, loadedRows } from '../../utils/quickActionFacts';
import { useSearchStore } from '../../stores/searchStore';
import { bulkDeleteFromServer, purgeEverywhereReporting } from '../../services/workflows/messageMutations';
import { formatPurgeEverywhereOutcome } from '../../utils/purgeOutcome';

export function useBulkActions({ formatArchiveBackupDeleteOutcome }) {
  const t = useT();
  const [bulkOpProgress, setBulkOpProgress] = useState(null);
  // Only a bulk selection's run (or one recovered after a relaunch) reports in
  // the corner panel; any other delete answers with its toast alone.
  useEffect(() => bulkOperationManager.subscribe((op, lifecycle) => { if (lifecycle?.panel) setBulkOpProgress(op); }), []);

  const handleBulkConfirm = async ({ action, uids }) => {
    const selectionState = useMailStore.getState();
    const scope = captureBulkScope(uids, selectionState);
    const { activeAccountId, accounts, activeMailbox } = selectionState;
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    // The run consumes the selection; the session is done either way.
    useMailStore.getState().endBulkSession();

    // Handle unarchive separately — not a bulk operation manager action
    if (action === 'unarchive') {
      const state = useMailStore.getState();
      const { removeLocalEmails, archivedEmailIds } = state;
      // Only archived messages have anything to remove, read by the selection
      // bar's rule: a key's own row, or the open folder's uids for a bare
      // key. One call for the run: one vault delete and one re-read per
      // (account, mailbox).
      const rows = loadedRows(state, useSearchStore.getState().searchResults);
      const targets = archivedSelectionKeys(uids, rows, archivedEmailIds, state);
      try { if (targets.length) await removeLocalEmails(targets); } catch (e) { console.error('Failed to unarchive the selection:', e); }
      useMailStore.getState().updateSortedEmails();
      return;
    }

    // Delete everywhere took its rows off the list at the click and retries
    // quietly; only what it could not do is said, as a toast. No panel.
    if (action === 'delete_everywhere') {
      purgeEverywhereReporting(uids, { scope }).catch(err => {
        console.error('[EmailList] Delete everywhere failed:', err);
        useMailStore.setState({ error: t('list.deleteFailed', { err: err?.message || err }) });
      });
      return;
    }

    try {
      // The selection's keys can name any account and folder; a bare uid
      // names the open folder's message only where the view is one folder.
      // A delete leaves the list at the click and reports by toast alone; the
      // corner panel is for archiving.
      if (action === 'delete') await bulkDeleteFromServer(scope);
      else {
        await bulkOperationManager.start({ type: action, scope, onProgress: op => setBulkOpProgress({ ...op }), panel: true });
        if (bulkOperationManager.operation?.status === 'complete') {
          await useMailStore.getState().loadEmails();
        }
      }

      // Only delete_everywhere and archive_backup_delete populate `result`
      // (BulkOperationManager.js) — null for every other action type, so this is a
      // no-op for them. The two shapes differ, so each has its own formatter.
      const opResult = bulkOperationManager.operation?.result;
      const skipped = bulkOperationManager.operation?.skipped || 0;
      const skippedLocal = bulkOperationManager.operation?.skippedLocal || 0;
      // What the manager refused (no one folder to run it in, or a folder no
      // server holds) is said, not dropped.
      const outcomeMessage = [
        action === 'archive_backup_delete' ? formatArchiveBackupDeleteOutcome(opResult) : formatPurgeEverywhereOutcome(opResult),
        skipped > 0 ? t('bulk.result.skippedNoFolder', { count: skipped }) : null,
        skippedLocal > 0 ? t('bulk.result.skippedLocalFolder', { count: skippedLocal }) : null,
      ].filter(Boolean).join(' ') || null;
      if (outcomeMessage) {
        // Reuses the store's `error` field, the one feedback channel already
        // wired to a Toast at the app root (App.jsx renders it off `error`/
        // `errorType`/`errorTypeFor`/`clearError`). `failed`/`queuedBackup`/
        // `needsResync` are caveats on a run that otherwise succeeded, not a
        // hard failure — `errorType: 'warning'` gets the warning-styled, 8s
        // Toast per docs/modal-standards.md instead of the default
        // error-red one. `errorTypeFor` must be set to this exact message:
        // App.jsx only trusts `errorType` when the two still match, which is
        // what stops this warning from tinting an unrelated later error.
        useMailStore.setState({ error: outcomeMessage, errorType: 'warning', errorTypeFor: outcomeMessage });
      }
    } catch (err) {
      console.error('[EmailList] Bulk operation failed:', err);
    }
  };

  const handleBulkCancel = async () => {
    try { await bulkOperationManager.cancel(); }
    catch (error) { useMailStore.setState({ error: error.message || String(error) }); }
  };

  return { bulkOpProgress, setBulkOpProgress, handleBulkConfirm, handleBulkCancel };
}
