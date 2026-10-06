// The one owner of the sidebar's per-account unread counts (`unreadPerAccount`,
// persisted in settingsStore) and of the total the dock badge shows and the
// tray menu's rows, which are derived from them and stored nowhere.
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
// The count of a folder is never read off rows that belong to another, and a
// recount counts only what the list itself would show (rowVisibility): a
// message it holds back is no unread message the user can find.
//
// No heavy work lives here: a recount is over rows the caller already holds,
// and a cache read is the caller's (the scheduler, off the click path).
import { useSettingsStore } from './settingsStore';
import { localSnoozeKeys, useSnoozeStore } from './snoozeStore';
import { useTagStore } from './tagStore';
import { useAutoTagStore } from './autoTagStore';
import { rowVisibility } from '../utils/rowVisibility';

const settings = () => useSettingsStore.getState();

// The store holding what the list keeps back (a delete's tombstone, the vault
// marks). It imports this module, so it hands itself over (mailStore.js).
let listStore = null;
export function setListStore(store) {
  listStore = store;
}

/// Would `accountId`'s INBOX list show a row of its cache? The list's own rule
/// set: a delete still owed to the server, \Deleted not yet expunged, an
/// auto-tag hide and a local snooze keep a message off it. A refused delete
/// left its row tombstoned while every sync brought it back unread from the
/// server's copy: "1" on the badge, "No unread messages" in the list.
/// `tombstones: false` is for a shift: a delete lays its tombstone before it
/// shifts and an undo lifts it before, so the message the shift is about
/// always has one.
function shownInInbox(accountId, { tombstones = true } = {}) {
  const s = listStore?.getState() ?? {};
  const hiddenTagIds = useAutoTagStore.getState().hiddenTagIds();
  return rowVisibility({
    activeAccountId: accountId,
    activeMailbox: 'INBOX',
    archivedEmailIds: s.archivedEmailIds,
    deleteTombstones: tombstones ? s.deleteTombstones : null,
    hiddenTagIds,
    tagsByRow: hiddenTagIds.size ? useTagStore.getState().byRow : null,
    localSnoozes: localSnoozeKeys(useSnoozeStore.getState().rows),
  });
}

/// Does `cache` hold the whole folder? Its row count reaches the folder's own.
export const isCompleteCache = (cache) =>
  Array.isArray(cache?.emails) && !(cache.totalEmails > cache.emails.length);

/// The sidebar's account rows as the tray menu lists them: `accounts` in the
/// sidebar's order, hidden ones left out, labelled and counted as it does.
/// A count whose account is not in `accounts` (one removed, or not loaded yet)
/// is no row. It stays in the store: a list still loading is not a removal.
export function unreadRows(state, accounts) {
  const hidden = state?.hiddenAccounts || {};
  const counts = state?.unreadPerAccount || {};
  const names = state?.displayNames || {};
  const ordered = state?.getOrderedAccounts ? state.getOrderedAccounts(accounts || []) : (accounts || []);
  return ordered
    .filter(a => !hidden[a.id])
    .map(a => ({ id: a.id, label: names[a.id] || a.name || a.email, unread: counts[a.id] || 0 }));
}

/// What the dock badge shows: the sum of the sidebar's rows, no more.
export const selectTotalUnread = (state, accounts) =>
  unreadRows(state, accounts).reduce((sum, row) => sum + row.unread, 0);

/// The unread count of `accountId`'s INBOX as `cache` (`{ emails, totalEmails }`)
/// tells it, or null when the cache is not complete. Only the rows the list
/// shows (shownInInbox).
export function inboxCount(accountId, cache) {
  if (!isCompleteCache(cache)) return null;
  const shown = shownInInbox(accountId);
  return cache.emails.filter(e => !e.flags?.includes('\\Seen') && shown(e)).length;
}

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
/// INBOX messages only, and not one the list holds back (shownInInbox): it was
/// never counted, so moving it moves nothing.
export function shiftInbox(entries, sign) {
  const byAccount = new Map();
  const shown = new Map();
  for (const { accountId, mailbox, row } of entries) {
    if (mailbox !== 'INBOX' || !accountId) continue;
    if (!shown.has(accountId)) shown.set(accountId, shownInInbox(accountId, { tombstones: false }));
    if (!shown.get(accountId)({ ...row, flags: (row?.flags || []).filter(f => f !== '\\Seen') })) continue;
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
