// The one owner of the sidebar's per-account unread counts (`unreadPerAccount`,
// persisted in settingsStore) and of the total the dock badge shows, which is
// derived from them and stored nowhere.
//
// It used to be written from five places with five rules: a recount of the
// rows the list held (a window onto a folder, or the rows of ANOTHER folder in
// All Inboxes Sent and in a branch listing), a +-1 shift, a recount from the
// daemon's cache, a bulk merge by the refresh, and a separately stored total
// that only two of them updated.
//
// The rule, for every writer: INBOX only. A count is recounted only from a
// COMPLETE cache (`emails` holding every message the folder has): a partial one
// reads as fewer unread. Anything else moves the count by one per message that
// changed state, and a message nothing loaded tells us about does not move it.
// The count of a folder is never read off rows that belong to another.
//
// No heavy work lives here: a recount is over rows the caller already holds,
// and a cache read is the caller's (the scheduler, off the click path).
import { useSettingsStore } from './settingsStore';
import { inboxUnread } from './snoozeStore';

const settings = () => useSettingsStore.getState();

/// Does `cache` hold the whole folder? Its row count reaches the folder's own.
export const isCompleteCache = (cache) =>
  Array.isArray(cache?.emails) && !(cache.totalEmails > cache.emails.length);

/// What the dock badge shows: every account that is not hidden.
export function selectTotalUnread(state) {
  const hidden = state?.hiddenAccounts || {};
  return Object.entries(state?.unreadPerAccount || {})
    .filter(([id]) => !hidden[id])
    .reduce((sum, [, count]) => sum + (count || 0), 0);
}

/// The unread count of `accountId`'s INBOX as `cache` (`{ emails, totalEmails }`)
/// tells it, or null when the cache is not complete. Less what a local snooze
/// holds out of the inbox, as the list.
export const inboxCount = (accountId, cache) =>
  (isCompleteCache(cache) ? inboxUnread(accountId, cache.emails) : null);

/// Recount `accountId`'s INBOX from `cache`, when it is complete. Returns
/// whether it wrote.
export function recountInbox(accountId, cache) {
  const n = inboxCount(accountId, cache);
  if (n === null) return false;
  settings().setUnreadForAccount(accountId, n);
  return true;
}

/// `entries` are `{ accountId, mailbox, row }`, one per message that stopped or
/// started counting: the caller has decided which way, `sign` is -1 or +1.
/// INBOX messages only, and not one a local snooze holds out of the inbox: it
/// was never counted, so moving it moves nothing.
export function shiftInbox(entries, sign) {
  const byAccount = new Map();
  for (const { accountId, mailbox, row } of entries) {
    if (mailbox !== 'INBOX' || !accountId) continue;
    if (!inboxUnread(accountId, [{ ...row, flags: [] }])) continue;
    byAccount.set(accountId, (byAccount.get(accountId) || 0) + sign);
  }
  const s = settings();
  for (const [id, n] of byAccount) {
    s.setUnreadForAccount(id, Math.max(0, (s.unreadPerAccount?.[id] || 0) + n));
  }
}

/// The entries of `rows` (`{ accountId, mailbox, row }`) that were unread.
export const unreadEntries = (entries) => entries.filter(({ row }) => !row?.flags?.includes('\\Seen'));

/// A cache too partial to recount still tells how many arrived.
export function addArrivals(accountId, count) {
  const s = settings();
  s.setUnreadForAccount(accountId, (s.unreadPerAccount?.[accountId] || 0) + count);
}

/// Counts a refresh measured from complete folders, over the ones it did not.
export function applyRecounts(measured) {
  const s = settings();
  s.setUnreadPerAccount({ ...s.unreadPerAccount, ...measured });
}

export function forgetAccount(accountId) {
  const { [accountId]: _removed, ...rest } = settings().unreadPerAccount || {};
  settings().setUnreadPerAccount(rest);
}
