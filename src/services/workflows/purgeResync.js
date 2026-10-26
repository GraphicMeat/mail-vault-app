// ── purgeResync — a delete refused for want of identity waits for the resync ──
//
// The native worker will not delete a row it cannot prove: a row cached before
// native identity existed carries none, and the worker refuses it as "needs
// resync". The user asked for a delete, so the delete is not dropped; the
// mailbox is synced (which stamps the identity), the row is read back, and the
// purge runs once more with the fresh evidence.
//
// A fresh row stands in for the original only when its Message-ID equals the
// one the user saw. A uid the server reissued to another message would pass
// every other check, so a hint with no Message-ID is never retried.

import * as db from '../db';
import { syncNow, waitForSync, toSyncAccount } from '../syncService';
import { bindNativeRows, captureSelectionSnapshot } from '../headerIdentity.js';
import { bulkOperationManager, originalTargetId } from '../BulkOperationManager.js';
import { normalizeMessageId } from '../../utils/emailParser';
import { _parseSelKey } from '../../stores/slices/unifiedHelpers';
import { useMailStore } from '../../stores/mailStore';

const SYNC_TIMEOUT_MS = 30000;

// Only a missing identity heals by syncing; a changed one is a different message.
const waitsForResync = ({ hint, target }) =>
  target?.refused && target.needsResync && target.lastError === 'errors.bulkIdentityUncertain'
  && !hint.nativeIdentity && hint.messageIdPresent && !!normalizeMessageId(hint.messageId);

async function reprove(accountId, mailbox, hints) {
  const account = useMailStore.getState().accounts.find((a) => a.id === accountId);
  if (!account) return [];
  try {
    const { ticket } = await syncNow(toSyncAccount(account), mailbox);
    if (!(await waitForSync(ticket, SYNC_TIMEOUT_MS))?.success) return [];
    const [rows, meta] = await Promise.all([
      db.getEmailHeadersByUids(accountId, mailbox, hints.map((hint) => hint.uid)),
      db.getEmailHeadersMeta(accountId, mailbox),
    ]);
    const bound = bindNativeRows(rows, meta?.nativeIdentity, accountId, mailbox);
    const proved = [];
    for (const hint of hints) {
      const row = bound.find((r) => r.uid === hint.uid);
      const fresh = row && captureSelectionSnapshot(row, accountId, mailbox);
      if (fresh?.nativeIdentity && normalizeMessageId(fresh.messageId) === normalizeMessageId(hint.messageId)) {
        proved.push({ original: hint, fresh });
      }
    }
    return proved;
  } catch (error) {
    console.warn('[purgeResync] resync of %s/%s failed:', accountId, mailbox, error);
    return [];
  }
}

/**
 * Resync the mailboxes of refused-for-identity targets and run the purge once
 * more over the rows that came back proved. Returns the operation to judge: the
 * first one untouched when nothing was retried, else the two merged, with each
 * retried outcome filed under its ORIGINAL hint, which is what the caller keys on.
 */
export async function retryAfterResync(operation, scope, onProgress) {
  const stale = (operation?.outcomes || []).filter(waitsForResync);
  if (!stale.length) return operation;
  const groups = new Map();
  for (const { hint } of stale) {
    const id = JSON.stringify([hint.accountId, hint.mailbox]);
    if (!groups.has(id)) groups.set(id, { accountId: hint.accountId, mailbox: hint.mailbox, hints: [] });
    groups.get(id).hints.push(hint);
  }
  const proved = [];
  for (const group of groups.values()) proved.push(...await reprove(group.accountId, group.mailbox, group.hints));
  if (!proved.length) return operation;

  const retried = new Set(proved.map(({ original }) => `${original.accountId}|${original.mailbox}|${original.uid}`));
  const keys = scope.keys.filter((key) => {
    const parsed = _parseSelKey(key);
    return retried.has(`${parsed.accountId || scope.accountId}|${parsed.accountId ? parsed.mailbox : scope.mailbox}|${parsed.uid}`);
  });
  const retry = await bulkOperationManager.start({
    type: 'delete_everywhere',
    scope: { ...scope, keys, targetHints: proved.map(({ fresh }) => fresh) },
    onProgress,
  });

  const byFresh = new Map((retry.outcomes || []).map((o) => [originalTargetId(o.hint), o.target]));
  const outcomes = (operation.outcomes || []).map((o) => {
    const match = proved.find(({ original }) => originalTargetId(original) === originalTargetId(o.hint));
    return match ? { hint: o.hint, target: byFresh.get(originalTargetId(match.fresh)) ?? o.target } : o;
  });
  const first = operation.result || {};
  const second = retry.result || {};
  // The first run counted each retried target as failed and its mailbox once as needing resync.
  const mailboxes = new Set(proved.map(({ original }) => `${original.accountId}|${original.mailbox}`)).size;
  return {
    ...operation,
    outcomes,
    result: {
      deleted: (first.deleted || 0) + (second.deleted || 0),
      failed: Math.max(0, (first.failed || 0) - proved.length) + (second.failed || 0),
      queuedBackup: (first.queuedBackup || 0) + (second.queuedBackup || 0),
      needsResync: Math.max(0, (first.needsResync || 0) - mailboxes) + (second.needsResync || 0),
    },
  };
}
