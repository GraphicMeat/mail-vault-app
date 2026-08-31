// Folder policy for auto-cleanup rules, in one place so the rule picker and the
// engine cannot drift. executeRule() refuses a rule whose folder is protected,
// so a folder offered here but protected there builds a rule that renders
// enabled and silently never runs.

/** Safety: folders the cleanup engine must never touch. */
export const PROTECTED_FOLDERS = new Set(['Drafts']);

/** Folders the rule picker may offer. Must not intersect PROTECTED_FOLDERS. */
export const CLEANUP_FOLDERS = ['INBOX', 'Sent', 'Trash', 'Junk', 'Archive'];
