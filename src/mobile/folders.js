// Folder names as the mobile UI shows them. The mobile language is fixed for the life of the page
// (see i18n.js), so the module `t` is safe here.
import { t } from './i18n.js';

/**
 * The open "folder" while All Inboxes is open: every account's inbox as one list (desktop's All
 * Inboxes), offered with two or more accounts. Never a real path (a NUL cannot be in one) and
 * never sent to the engine: rows of that list name their own `accountId` and `folder`.
 */
export const ALL_INBOXES = '\u0000allInboxes';

const SPECIAL_KEYS = {
  '\\inbox': 'sidebar.inbox',
  '\\drafts': 'sidebar.drafts',
  '\\sent': 'mobile.folder.sent',
  '\\archive': 'common.archive',
  '\\junk': 'mobile.folder.junk',
  '\\trash': 'mobile.folder.trash',
};

/** The name the user sees: INBOX and special-use folders translated, others as the server names them. */
export function folderLabel(folder) {
  if (!folder) return '';
  if (folder.path.toUpperCase() === 'INBOX') return t('sidebar.inbox');
  const key = SPECIAL_KEYS[String(folder.specialUse || '').toLowerCase()];
  return key ? t(key) : folder.name || folder.path;
}

/**
 * The account's Drafts folder (special use `\Drafts`, any case) when it can be opened, else null.
 * While there is one it is the drawer's one Drafts and lists the phone's local drafts on top.
 */
export function draftsFolder(folders) {
  return (folders || []).find((f) => !f.noselect && String(f.specialUse || '').toLowerCase() === '\\drafts') || null;
}

/** Desktop's spelling of each special use, for its mailbox glyphs (src/utils/mailboxIcon.js). */
const SPECIAL_CANONICAL = {
  '\\inbox': '\\Inbox', '\\sent': '\\Sent', '\\drafts': '\\Drafts', '\\trash': '\\Trash', '\\junk': '\\Junk',
  '\\starred': '\\Starred', '\\important': '\\Important', '\\archive': '\\Archive', '\\all': '\\All',
};

/**
 * The folder as desktop's mailbox glyph lookup reads it: the engine passes the server's spelling of
 * the special use (any case), desktop's table is keyed by one spelling.
 */
export function iconMailbox(folder) {
  const use = SPECIAL_CANONICAL[String(folder.specialUse || '').toLowerCase()] || null;
  const path = folder.path.toUpperCase() === 'INBOX' ? 'INBOX' : folder.path;
  return { path, specialUse: use };
}
