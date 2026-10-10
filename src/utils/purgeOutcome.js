import { t } from '../i18n/index.js';

// purgeEverywhere's four outcome counts aren't mutually exclusive — one run
// can produce several at once (e.g. a few uids held back for resync AND a
// few backup copies queued) — so every non-zero count gets its own clause
// instead of an if/else chain that would silently report only the first.
// A clean run (nothing held back, nothing queued, nothing failed) returns
// null: there's nothing to warn about, the list already reflects the delete.
export function formatPurgeEverywhereOutcome(result) {
  if (!result) return null;
  const { deleted = 0, failed = 0, queuedBackup = 0, needsResync = 0 } = result;
  if (!failed && !queuedBackup && !needsResync) return null;

  const clauses = [`${deleted} removed.`];
  if (failed > 0) {
    clauses.push(t('list.deleteFailedOnServer', { count: failed }));
  }
  if (queuedBackup > 0) {
    clauses.push(t('list.backupWillBeRemoved', { count: queuedBackup }));
  }
  if (needsResync > 0) {
    // The UID space couldn't be trusted, so these were held back entirely —
    // no server delete, no vault purge, no backup purge. Without this clause
    // a user selecting only stale-UID messages sees "0 removed" and nothing
    // else, with no hint that retrying won't help until the mailbox resyncs.
    clauses.push(t('list.skippedNeedsResync', { count: needsResync }));
  }
  return clauses.join(' ');
}
