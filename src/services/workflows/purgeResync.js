// ── purgeResync — a delete refused for want of identity is proved, then retried ──
//
// The native worker will not delete a row it cannot prove: a row cached before
// native identity existed carries none, and so does a search hit, and the worker
// refuses either as "needs resync". The user asked for a delete, so the delete
// is not dropped. The header cache proves the row where it can; where it cannot,
// the mailbox is synced (which stamps the identity) and the cache is read again;
// then the purge runs once more with the fresh evidence.
//
// A fresh row stands in for the original only when its Message-ID equals the
// one the user saw. A uid the server reissued to another message would pass
// every other check, so a hint with no Message-ID is never retried.

import * as db from '../db';
import { syncNow, waitForSync, toSyncAccount } from '../syncService';
import { bindNativeRows, captureSelectionSnapshot, nativeIdentityOf } from '../headerIdentity.js';
import { bulkOperationManager, originalTargetId } from '../BulkOperationManager.js';
import { normalizeMessageId } from '../../utils/emailParser';
import { _parseSelKey } from '../../stores/slices/unifiedHelpers';
import { useMailStore } from '../../stores/mailStore';

const SYNC_TIMEOUT_MS = 30000;

const IDENTITY_CHANGED = 'errors.bulkIdentityChanged';
const midOf = (hint) => (hint?.messageIdPresent ? normalizeMessageId(hint.messageId) : '') || '';

// Only a missing identity heals by proving; a changed one is a different message.
const waitsForResync = ({ hint, target }) =>
  target?.refused && target.needsResync && target.lastError === 'errors.bulkIdentityUncertain'
  && !hint.nativeIdentity && !!midOf(hint);

// Prove hints from the header cache: a cached row with the same Message-ID, or,
// for a uid the cache never held (a search hit past the cached window), the
// folder's own identity. Either way the worker re-reads UIDVALIDITY and the
// Message-ID at that uid on the server before it deletes, so a uid that now
// names another message is refused there. A cached row with ANOTHER Message-ID
// is the opposite: proof the uid moved on.
async function proveFromCache(accountId, mailbox, hints) {
  const [rows, meta] = await Promise.all([
    db.getEmailHeadersByUids(accountId, mailbox, hints.map((hint) => hint.uid)),
    db.getEmailHeadersMeta(accountId, mailbox),
  ]);
  const identity = nativeIdentityOf(meta?.nativeIdentity, accountId, mailbox);
  const bound = bindNativeRows(rows, identity, accountId, mailbox);
  const proved = [];
  const changed = [];
  for (const hint of hints) {
    const row = bound.find((r) => r.uid === hint.uid);
    const fresh = row && captureSelectionSnapshot(row, accountId, mailbox);
    const mid = midOf(fresh);
    if (mid && mid !== midOf(hint)) changed.push(hint);
    else if (fresh?.nativeIdentity && mid) proved.push({ original: hint, fresh });
    else if (!row && identity?.uidValidity != null) {
      proved.push({ original: hint, fresh: Object.freeze({ ...hint, nativeIdentity: identity }) });
    }
  }
  return { proved, changed };
}

// The cache first; a sync only for what it could not settle.
async function reprove(accountId, mailbox, hints) {
  let first = { proved: [], changed: [] };
  try {
    first = await proveFromCache(accountId, mailbox, hints);
    const settled = new Set([...first.proved.map(({ original }) => original), ...first.changed]);
    const left = hints.filter((hint) => !settled.has(hint));
    if (!left.length) return first;
    const account = useMailStore.getState().accounts.find((a) => a.id === accountId);
    if (!account) return first;
    const { ticket } = await syncNow(toSyncAccount(account), mailbox);
    if (!(await waitForSync(ticket, SYNC_TIMEOUT_MS))?.success) return first;
    const second = await proveFromCache(accountId, mailbox, left);
    return { proved: [...first.proved, ...second.proved], changed: [...first.changed, ...second.changed] };
  } catch (error) {
    console.warn('[purgeResync] proving %s/%s failed:', accountId, mailbox, error);
    return first;
  }
}

/**
 * Resync the mailboxes of refused-for-identity targets and run the purge once
 * more over the rows that came back proved. Returns the operation to judge: the
 * first one untouched when nothing was retried, else the two merged, with each
 * retried outcome filed under its ORIGINAL hint, which is what the caller keys on.
 */
export async function retryAfterResync(operation, scope, onProgress, panel) {
  const stale = (operation?.outcomes || []).filter(waitsForResync);
  if (!stale.length) return operation;
  const groups = new Map();
  for (const { hint } of stale) {
    const id = JSON.stringify([hint.accountId, hint.mailbox]);
    if (!groups.has(id)) groups.set(id, { accountId: hint.accountId, mailbox: hint.mailbox, hints: [] });
    groups.get(id).hints.push(hint);
  }
  const proved = [];
  const changed = new Set();
  for (const group of groups.values()) {
    const found = await reprove(group.accountId, group.mailbox, group.hints);
    proved.push(...found.proved);
    for (const hint of found.changed) changed.add(originalTargetId(hint));
  }
  // The cache shows another message under the uid: refused as changed, so the
  // row comes back and nothing queues a delete for it.
  if (changed.size) {
    operation = {
      ...operation,
      outcomes: operation.outcomes.map((o) => (changed.has(originalTargetId(o.hint))
        ? { ...o, target: { ...o.target, lastError: IDENTITY_CHANGED } } : o)),
    };
  }
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
    panel,
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
  const keptLocal = (first.keptLocal || 0) + (second.keptLocal || 0);
  return {
    ...operation,
    outcomes,
    result: {
      deleted: (first.deleted || 0) + (second.deleted || 0),
      failed: Math.max(0, (first.failed || 0) - proved.length) + (second.failed || 0),
      queuedBackup: (first.queuedBackup || 0) + (second.queuedBackup || 0),
      needsResync: Math.max(0, (first.needsResync || 0) - mailboxes) + (second.needsResync || 0),
      // Omitted at zero, as the daemon serializes it.
      ...(keptLocal ? { keptLocal } : {}),
    },
  };
}
