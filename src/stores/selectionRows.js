// ── A selection's keys as the messages they name ──
//
// The selection holds KEYS, and the rows behind them live in many places: the
// folder's lists, a search's or a saved view's hits, the reader, the caches
// (messageRows' pool). Some keys name a message no row holds at all: the bulk
// modal's date range and a view selected past the rows it renders. Those
// still carry the snapshot the selection took (`selectedEmailSnapshots`), and
// a full key names its account and folder by itself. A bulk action that
// filtered one list (the export read `sortedEmails` only) silently did
// nothing in a view; every bulk action resolves the selection here instead.

import { resolvePool, indexRows } from './messageRows';
import { selectionKey, resolveEmailLocation, _parseSelKey } from './slices/unifiedHelpers';

/// Every row a key can resolve to, by selection key: `rows` first (the lists
/// the caller already holds), then the registry's pool. First row per key wins.
export function selectionRowIndex(state, rows = []) {
  return indexRows([...rows, ...resolvePool(state)], email => selectionKey(email, state));
}

/// `keys` as `{ key, email, location, offScreen, keyOnly }`, in selection
/// order. `offScreen` marks a message no row holds: its `email` is built from
/// the selection's snapshot (Message-ID included) or, failing that, from the
/// key alone (`keyOnly`).
/// A key that names no account or folder at all is in `missing`.
export function resolveSelection(keys, state, { rows = [], index = selectionRowIndex(state, rows) } = {}) {
  const resolved = [];
  const missing = [];
  for (const key of keys) {
    const email = index.get(key);
    if (email) {
      resolved.push({ key, email, location: resolveEmailLocation(email, state), offScreen: false });
      continue;
    }
    const snapshot = state.selectedEmailSnapshots?.get?.(key);
    const parsed = _parseSelKey(key);
    const accountId = snapshot?.accountId || parsed.accountId || (parsed.mailbox == null ? state.activeAccountId : null);
    const mailbox = snapshot?.mailbox || parsed.mailbox || (parsed.accountId ? null : state.activeMailbox);
    const uid = snapshot?.uid ?? parsed.uid;
    if (!accountId || !mailbox || mailbox === 'UNIFIED' || uid == null) {
      missing.push(key);
      continue;
    }
    const stub = { uid, _accountId: accountId, _mailbox: mailbox };
    if (snapshot?.messageId) stub.messageId = snapshot.messageId;
    // `keyOnly`: nothing but the key names it, no evidence of what it is.
    resolved.push({ key, email: stub, location: { accountId, mailbox }, offScreen: true, keyOnly: !snapshot });
  }
  return { resolved, missing };
}
