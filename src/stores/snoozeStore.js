import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { normalizeMessageId } from '../utils/emailParser.js';

// Rows from `snooze.*` (src-daemon/src/handlers/snooze.rs), modeled on
// scheduledStore.js: one flat list of snoozed/failed rows, refetched on
// launch, patched from the `snooze` daemon event.
export const useSnoozeStore = create((set, get) => ({
  rows: [],

  loadRows: async () => {
    const rows = await daemonCall('snooze.list', {});
    set({ rows: Array.isArray(rows) ? rows : [] });
    return get().rows;
  },

  upsert: (rows) => set(state => {
    const ids = new Set(rows.map(r => r.id));
    return { rows: [...state.rows.filter(r => !ids.has(r.id)), ...rows] };
  }),

  /// `{id, state}` off the `snooze` event. A woken row is history: drop it.
  applyEvent: (payload) => {
    if (!payload?.id) return;
    set(state => ({
      rows: payload.state === 'woken'
        ? state.rows.filter(r => r.id !== payload.id)
        : state.rows.map(r => (r.id === payload.id ? { ...r, state: payload.state } : r)),
    }));
  },
}));

/// When the message `messageId` on `accountId` wakes, or null. What a row in
/// the Snoozed folder shows instead of its date.
export function wakeAtFor(rows, accountId, messageId) {
  if (!accountId || !messageId) return null;
  const id = normalizeMessageId(messageId);
  return rows.find(r => r.accountId === accountId && normalizeMessageId(r.messageId) === id)?.wakeAt ?? null;
}

// ── local snooze ──
//
// A server that will not host a Snoozed folder gets a local snooze
// (services/workflows/snooze.js): nothing moves, the row's `snoozedMailbox` is
// '', and the list holds the message out of its folder until the row wakes.

export const localSnoozeKey = (accountId, mailbox, messageId) =>
  `${accountId}\x01${mailbox}\x01${normalizeMessageId(messageId)}`;

/// The messages local snoozes are holding out of the list right now. A
/// `failed` row's message shows again: nothing is going to wake it.
export function localSnoozeKeys(rows) {
  const keys = new Set();
  for (const r of rows) {
    if (r.snoozedMailbox === '' && r.state === 'snoozed') keys.add(localSnoozeKey(r.accountId, r.fromMailbox, r.messageId));
  }
  return keys;
}

/// Unread messages among `emails`, `accountId`'s INBOX rows, less the ones a
/// local snooze holds out of it: the badge counts what the inbox shows.
export function inboxUnread(accountId, emails) {
  const held = localSnoozeKeys(useSnoozeStore.getState().rows);
  let n = 0;
  for (const e of emails) {
    if (e.flags?.includes('\\Seen')) continue;
    if (held.size && e.messageId && held.has(localSnoozeKey(accountId, 'INBOX', e.messageId))) continue;
    n++;
  }
  return n;
}

// A local wake only clears \Seen, so no sync reports an arrival: the banner
// is raised here, previewing that message rather than the folder's newest.
async function announceLocalWake(row) {
  const [{ getEmailHeaders }, { notifyArrival }] = await Promise.all([
    import('../services/db'),
    import('../hooks/useEmailScheduler'),
  ]);
  const id = normalizeMessageId(row.messageId);
  const cache = await getEmailHeaders(row.accountId, row.fromMailbox);
  const header = cache?.emails?.find(e => normalizeMessageId(e.messageId) === id) || null;
  notifyArrival(row.accountId, row.fromMailbox, 1, header);
}

// The daemon's sync wrote the cleared \Seen into the header cache, and the
// mailbox's modseq with it, before the event went out: the list's reload
// finds nothing changed and never reads a row. So the rows the snooze held
// are marked unread here. A restore window saved before the snooze still
// holds the message read, and All Inboxes repaints from those first.
async function markWokenUnread(row, applySeenLocally) {
  const [{ useMailStore }, { invalidateRestoreDescriptors }] = await Promise.all([
    import('./mailStore'),
    import('../services/cacheManager'),
  ]);
  invalidateRestoreDescriptors(row.accountId);
  const s = useMailStore.getState();
  // The key deriveDisplayRows held these rows out by.
  const spans = s.unifiedInbox || s.activeMailbox === 'UNIFIED';
  const key = localSnoozeKey(row.accountId, row.fromMailbox, row.messageId);
  for (const e of s.emails) {
    if (!e.messageId || !e.flags?.includes('\\Seen')) continue;
    if (localSnoozeKey(e._accountId || s.activeAccountId, e._mailbox || (spans ? 'INBOX' : s.activeMailbox), e.messageId) !== key) continue;
    applySeenLocally(useMailStore, { accountId: row.accountId, mailbox: row.fromMailbox, uid: e.uid, read: false, isUnified: spans });
  }
}

async function listenTo(event, cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

let _initialized = false;

/// Called once at app launch (App.jsx, beside initScheduledSend). A wake also
/// syncs the destination and reports it as new mail through the sync engine;
/// this keeps the rows current, repaints a list that shows Snoozed, and shows
/// a local snooze's message unread and announces it, which the sync cannot.
export function initSnooze() {
  if (_initialized) return;
  _initialized = true;
  useSnoozeStore.getState().loadRows().catch(() => {});
  listenTo('snooze', async (payload) => {
    // Read before applyEvent drops it.
    const row = useSnoozeStore.getState().rows.find(r => r.id === payload?.id);
    useSnoozeStore.getState().applyEvent(payload);
    if (payload?.state !== 'woken') return;
    const { reloadListInView, applySeenLocally } = await import('../services/workflows/messageMutations');
    // `woke` is false for an undo, which left \Seen alone: that is no news.
    const localWake = payload.woke && row?.snoozedMailbox === '';
    if (localWake) await markWokenUnread(row, applySeenLocally).catch(() => {});
    reloadListInView().catch(() => {});
    if (localWake) await announceLocalWake(row).catch(() => {});
  });
}
