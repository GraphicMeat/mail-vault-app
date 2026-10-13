import { rowIdentity, vaultHas } from '../stores/slices/unifiedHelpers';
import { localSnoozeKey } from '../stores/snoozeStore';
import { isHiddenFromInbox } from './autoTagInboxFilter';

/**
 * The one rule set for which rows a list shows, as a predicate over a row.
 * `deriveDisplayRows` filters by it, and so does anything acting on rows the
 * list holds back: the Bulk Operations pool reads the sidecar cache, which
 * outlives the list's own filtering, and used to re-implement (and lose part
 * of) these rules.
 *
 *  - a message the server flagged \Deleted but has not expunged, unless its
 *    vault copy is archived (the local vault outranks the server's opinion
 *    about a message it has not actually removed);
 *  - an Auto Tags "hide from Inbox" message, in its own Inbox (see
 *    isHiddenFromInbox);
 *  - a message deleted here and not yet reconciled (a tombstone), so stale
 *    cache hydration on an account/folder switch cannot resurrect it;
 *  - a message a local snooze holds out of the folder it is still in;
 *  - a message a saved view holds, while "hide mail views hold" is on
 *    (`viewHidden`: the daemon's complete `account|mailbox|uid` key set, or
 *    null for unknown, which hides nothing). Never inside a view or a
 *    search (`inView`): there the view's or the search's own rows are what
 *    the person asked to see.
 *
 * A row is placed by where it lives (rowIdentity), never by the view's folder.
 * A row carrying `isArchived` (stamped by the derivation) is taken at its
 * word; an unstamped one (a cache row) is looked up in `archivedEmailIds`.
 */
export function rowVisibility({
  activeAccountId = null,
  activeMailbox = null,
  unifiedInbox = false,
  archivedEmailIds = null,
  deleteTombstones = null,
  hiddenTagIds = null,
  tagsByRow = null,
  localSnoozes = null,
  viewHidden = null,
  inView = false,
}) {
  const view = { activeAccountId, activeMailbox };
  const spans = unifiedInbox || activeMailbox === 'UNIFIED';
  const viewHolds = viewHidden?.size && !inView ? viewHidden : null;
  return (e) => {
    const archived = typeof e.isArchived === 'boolean' ? e.isArchived : vaultHas(archivedEmailIds, e, view);
    if (!archived && e.flags?.includes('\\Deleted')) return false;
    if (isHiddenFromInbox(e, { hiddenTagIds, tagsByRow, unifiedInbox, activeMailbox, activeAccountId })) return false;
    if (deleteTombstones?.size || viewHolds) {
      const id = rowIdentity(e, view);
      const key = id && `${id.accountId}|${id.mailbox}|${id.uid}`;
      if (key && deleteTombstones?.has(key)) return false;
      if (key && viewHolds?.has(key)) return false;
    }
    if (localSnoozes?.size && e.messageId && localSnoozes.has(localSnoozeKey(
      e._accountId || activeAccountId, e._mailbox || (spans ? 'INBOX' : activeMailbox), e.messageId))) return false;
    return true;
  };
}
