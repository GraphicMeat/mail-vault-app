import { create } from 'zustand';

/// Which messages some saved view holds, so the mailbox lists can leave them
/// out while `hideViewMail` is on. The daemon decides membership
/// (`views.hidden_members`); this only keeps its answer. `null` everywhere is
/// "unknown" (setting off, index not ready, call failed) and means show
/// everything. An empty Set is a complete answer that hides nothing.
///
/// Imports no other store: the mail store subscribes to this one, and the
/// view store fills it (`refreshHiddenMembers`).
const UNKNOWN = { keys: null, unreadByMailbox: null, hiddenByMailbox: null };

const sameSet = (a, b) => a instanceof Set && a.size === b.size && [...b].every(key => a.has(key));
const sameCounts = (a, b) => !!a && Object.keys(a).length === Object.keys(b).length
  && Object.keys(b).every(box => a[box] === b[box]);

export const useViewHideStore = create((set, get) => ({
  /// `${accountId}|${mailbox}|${uid}` of every held message, or null.
  keys: null,
  /// `${accountId}|${mailbox}` → unread messages hidden there, or null.
  unreadByMailbox: null,
  /// `${accountId}|${mailbox}` → messages hidden there, or null.
  hiddenByMailbox: null,

  setMembers: reply => {
    if (!reply?.available) {
      get().clear();
      return;
    }
    const keys = new Set();
    const unreadByMailbox = {};
    const hiddenByMailbox = {};
    for (const [accountId, mailboxes] of Object.entries(reply.members || {})) {
      for (const [mailbox, held] of Object.entries(mailboxes || {})) {
        const uids = Array.isArray(held?.uids) ? held.uids : [];
        for (const uid of uids) keys.add(`${accountId}|${mailbox}|${uid}`);
        const box = `${accountId}|${mailbox}`;
        hiddenByMailbox[box] = uids.length;
        unreadByMailbox[box] = Number.isFinite(held?.unread) ? held.unread : 0;
      }
    }
    // Identity is what repaints: a part that did not change keeps the object
    // it had, and an answer that changed nothing sets nothing. Every count
    // refresh asks again, and most of those answers are the same.
    const current = get();
    const next = {};
    if (!sameSet(current.keys, keys)) next.keys = keys;
    if (!sameCounts(current.unreadByMailbox, unreadByMailbox)) next.unreadByMailbox = unreadByMailbox;
    if (!sameCounts(current.hiddenByMailbox, hiddenByMailbox)) next.hiddenByMailbox = hiddenByMailbox;
    if (Object.keys(next).length) set(next);
  },

  clear: () => {
    const current = get();
    if (current.keys === null && current.unreadByMailbox === null && current.hiddenByMailbox === null) return;
    set(UNKNOWN);
  },
}));
