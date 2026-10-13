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

export const useViewHideStore = create(set => ({
  /// `${accountId}|${mailbox}|${uid}` of every held message, or null.
  keys: null,
  /// `${accountId}|${mailbox}` → unread messages hidden there, or null.
  unreadByMailbox: null,
  /// `${accountId}|${mailbox}` → messages hidden there, or null.
  hiddenByMailbox: null,

  setMembers: reply => {
    if (!reply?.available) {
      set(UNKNOWN);
      return;
    }
    // A new Set per answer: its identity changing is what repaints the lists.
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
    set({ keys, unreadByMailbox, hiddenByMailbox });
  },

  clear: () => set(UNKNOWN),
}));
