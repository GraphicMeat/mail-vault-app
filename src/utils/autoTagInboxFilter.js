import { tagRowKey } from '../stores/tagStore';

/// The mailbox a display row is actually in: its own `_mailbox` when it carries
/// one (a unified row, a row of a folder branch), else the same default
/// `_resolveUnifiedContext` (unifiedHelpers.js) uses for a unified row
/// (INBOX), else the folder on screen. A branch rooted at the Inbox lists its
/// subfolders' rows under `activeMailbox` INBOX, and reading that for every
/// row treated them as Inbox rows.
export function rowMailbox(email, unifiedInbox, activeMailbox) {
  return email._mailbox || (unifiedInbox ? 'INBOX' : activeMailbox);
}

/**
 * Auto Tags "hide from Inbox" (Phase 4). The daemon stores a rule's
 * `inboxAction: 'hide'` as a local fact only — `src-daemon/src/handlers/
 * auto_tags.rs` never touches a mailbox or moves anything — so the app is
 * what actually has to keep a hidden-tag message out of the Inbox listing.
 *
 * Scoped to the row's own INBOX only: the message must stay reachable
 * through its tag, through search (searchStore keeps its own `searchResults`
 * list, never this one) and by opening its actual folder. `tagsByRow` is
 * tagStore's own render cache (rowKey -> tag ids) — a row this cache does
 * not know about yet is never hidden on the strength of a guess.
 *
 * Called from exactly one place, `deriveDisplayRows` in messageListSlice.js
 * — the Inbox's own single display-row derivation — so no per-view or
 * per-call-site copy of this rule can drift from it.
 */
export function filterHiddenFromInbox(rows, options) {
  if (!options.hiddenTagIds?.size || !options.tagsByRow) return rows;
  return rows.filter(email => !isHiddenFromInbox(email, options));
}

/// The same rule for one row: is it an Inbox row carrying a hidden tag?
export function isHiddenFromInbox(email, { hiddenTagIds, tagsByRow, unifiedInbox, activeMailbox, activeAccountId }) {
  if (!hiddenTagIds?.size || !tagsByRow) return false;
  if (rowMailbox(email, unifiedInbox, activeMailbox) !== 'INBOX') return false;
  const key = tagRowKey(email._accountId || activeAccountId, 'INBOX', email.uid);
  const tagIds = tagsByRow[key];
  return !!tagIds?.some(id => hiddenTagIds.has(id));
}
