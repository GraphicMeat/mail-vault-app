// Folder names as the mobile UI shows them. The mobile language is fixed for the life of the page
// (see i18n.js), so the module `t` is safe here.
import { t } from './i18n.js';

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
