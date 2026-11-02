import { t } from '../i18n/index.js';

// purgeEverywhere's four outcome counts aren't mutually exclusive — one run
// can produce several at once (e.g. a few uids held back for resync AND a
// few backup copies queued) — so every non-zero count gets its own clause
// instead of an if/else chain that would silently report only the first.
// A clean run (nothing held back, nothing queued, nothing failed) returns
// null: there's nothing to warn about, the list already reflects the delete.
export function formatPurgeEverywhereOutcome(result) {
  if (!result) return null;
  const { deleted = 0, failed = 0, changed = 0, keptLocal = 0, queuedBackup = 0, needsResync = 0 } = result;
  if (!failed && !changed && !keptLocal && !queuedBackup && !needsResync) return null;

  const clauses = [`${deleted} removed.`];
  if (failed > 0) {
    clauses.push(t('list.deleteFailedOnServer', { count: failed }));
  }
  if (changed > 0) {
    // Another message now holds the uid: nothing failed on the server and a
    // resync would not help; the list reloads to show what the server holds.
    clauses.push(t('list.deleteChangedOnServer', { count: changed }));
  }
  if (keptLocal > 0) {
    // The server copy is gone; the local copy stayed because its bytes could
    // not be proved to be that message (a provider row without its id).
    clauses.push(t('list.deleteKeptLocal', { count: keptLocal }));
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

// A target refused because another message now holds its uid did not fail on
// the server, and no resync makes it deletable: the list shows what the server
// holds now. It leaves `failed` for `changed`, and a mailbox whose only reason
// to resync was such a target leaves `needsResync`. Never queued
// (messageMutations `_purgeQueueable`), so `_nativePurge`'s queued adjustment
// never counts it again.
export function splitChangedOutcome(result, finals) {
  const changed = finals.filter(target => target?.refused && !target.skipped
    && target.lastError === 'errors.bulkIdentityChanged');
  if (!changed.length) return result;
  // Counted afresh from the final outcomes, never subtracted from a total an
  // earlier step (retryAfterResync) has already adjusted: the mailboxes that
  // still hold a target waiting for a resync that is not a changed one.
  const resync = new Set(finals.filter(target => target?.needsResync && !changed.includes(target))
    .map(target => JSON.stringify([target.accountId, target.mailbox])));
  return { ...result, failed: Math.max(0, (result.failed || 0) - changed.length),
    needsResync: resync.size, changed: changed.length };
}
