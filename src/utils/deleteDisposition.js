// What a "Delete from server" does to a message, as far as the confirmation can tell before the
// daemon asks the server: the words only. The decision itself is core's delete rule
// (`src-core/src/actions/policy.rs`, owner decision 1), applied by the daemon when the delete
// runs: outside Trash a delete moves the message to Trash; inside Trash it is permanent; an
// account with no Trash still moves INBOX and deletes anywhere else for good.
//
// The daemon finds Trash by SPECIAL-USE, then by name (`imap::find_role_mailbox` over
// `imap::TRASH_CANDIDATES`); the folder list in the store carries the same SPECIAL-USE, and the
// names are pinned to core's by a test.

/** core `imap::TRASH_CANDIDATES`, in order. */
export const TRASH_CANDIDATES = ['Trash', 'Deleted Items', 'Deleted', '[Gmail]/Trash'];

const leaf = (path) => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('.'));
  return cut < 0 ? path : path.slice(cut + 1);
};

/**
 * The account's Trash in `mailboxes` (`[{path, specialUse}]`), found the way core finds it:
 * the first folder whose special-use is Trash, then each candidate name by full path, then by
 * last segment, case-insensitive. `null` when there is none.
 */
export function trashOf(mailboxes) {
  const list = Array.isArray(mailboxes) ? mailboxes.filter(m => m && typeof m.path === 'string') : [];
  const bySpecialUse = list.find(m => String(m.specialUse || '').toLowerCase().includes('trash'));
  if (bySpecialUse) return bySpecialUse.path;
  for (const cand of TRASH_CANDIDATES) {
    const c = cand.toLowerCase();
    const exact = list.find(m => m.path.toLowerCase() === c);
    if (exact) return exact.path;
    const byLeaf = list.find(m => leaf(m.path).toLowerCase() === c);
    if (byLeaf) return byLeaf.path;
  }
  return null;
}

/**
 * `'trash'` (the delete moves it to Trash), `'permanent'` (it is gone from the server) or
 * `'unknown'` (the folder list of that account is not loaded, so the copy must not claim either).
 *
 * @param {string} mailbox the folder the message is deleted from
 * @param {Array<{path:string, specialUse?:string}>|null} mailboxes that account's folder list,
 *        or null when it is not known
 */
export function serverDeleteDisposition(mailbox, mailboxes) {
  if (!mailbox) return 'unknown';
  const inbox = mailbox.toUpperCase() === 'INBOX';
  if (!Array.isArray(mailboxes) || mailboxes.length === 0) return inbox ? 'trash' : 'unknown';
  const trash = trashOf(mailboxes);
  if (trash === mailbox) return 'permanent';
  if (trash) return 'trash';
  return inbox ? 'trash' : 'permanent';
}

/**
 * One answer for a set of deletes: the same one when they agree, else `'unknown'`.
 *
 * @param {Array<{accountId:string, mailbox:string}|null>} locations
 * @param {{activeAccountId?:string, mailboxes?:Array}} state the mail store; only the active
 *        account's folder list is loaded
 */
export function serverDeleteDispositionOf(locations, state) {
  const answers = new Set((locations || []).map(loc => {
    if (!loc) return 'unknown';
    const mailboxes = loc.accountId === state?.activeAccountId ? state?.mailboxes : null;
    return serverDeleteDisposition(loc.mailbox, mailboxes);
  }));
  return answers.size === 1 ? [...answers][0] : 'unknown';
}
