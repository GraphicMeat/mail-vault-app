// Folder policy for auto-cleanup rules, in one place so the rule picker and the
// engine cannot drift. executeRule() refuses a rule whose folder is protected,
// so a folder offered here but protected there builds a rule that renders
// enabled and silently never runs.

/** Safety: folders the cleanup engine must never touch. */
export const PROTECTED_FOLDERS = new Set(['Drafts']);

/**
 * Folders the rule picker may offer. Must not intersect PROTECTED_FOLDERS.
 * These are ROLES, not mailbox paths - see resolveCleanupFolders. 'all' is the
 * every-folder sentinel, labelled with settings.backup.account.allFolders.
 */
export const CLEANUP_FOLDERS = ['all', 'INBOX', 'Sent', 'Trash', 'Junk', 'Archive'];

/** IMAP SPECIAL-USE attribute for each role the picker offers. */
const SPECIAL_USE = {
  Sent: '\\Sent', Trash: '\\Trash', Junk: '\\Junk', Archive: '\\Archive',
};

/** Last segment of a mailbox path, for either delimiter a server may use. */
const leaf = (path) => String(path || '').split(/[/.]/).filter(Boolean).pop() || '';

const isDrafts = (box) => box?.specialUse === '\\Drafts'
  || PROTECTED_FOLDERS.has(leaf(box?.path))
  || PROTECTED_FOLDERS.has(box?.name);

/** The one folder a rule may empty permanently; everything else moves to Trash. */
export function isTrashFolder(box) {
  return box?.specialUse === '\\Trash' || leaf(box?.path).toLowerCase() === 'trash';
}

/**
 * The mailboxes a rule's folder names on THIS account.
 *
 * A rule stores one word from the picker. On Dovecot the account's folders are
 * `INBOX.Sent`, `INBOX.Trash`… - nothing but INBOX matches that word, so a
 * "Sent" rule read an empty header cache and reported a clean run for ever.
 *
 * Takes the account's cached mailbox list and returns the entries themselves
 * (the caller needs `specialUse` for the permanent-delete decision, not just
 * the path). Nothing matched → [], which is a rule that does nothing, never a
 * fallback to the literal.
 */
export function resolveCleanupFolders(ruleFolder, mailboxes) {
  const boxes = (mailboxes || []).filter(b => b?.path && !b.noselect && !isDrafts(b));
  if (ruleFolder === 'all') return boxes;

  const wanted = String(ruleFolder || '').toLowerCase();
  if (wanted === 'inbox') {
    const inbox = boxes.find(b => b.path.toLowerCase() === 'inbox');
    return inbox ? [inbox] : [];
  }

  const role = SPECIAL_USE[ruleFolder];
  const hit = (role && boxes.find(b => b.specialUse === role))
    || boxes.find(b => b.path === ruleFolder)
    || boxes.find(b => leaf(b.path).toLowerCase() === wanted);
  return hit ? [hit] : [];
}
