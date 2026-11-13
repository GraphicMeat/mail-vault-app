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
