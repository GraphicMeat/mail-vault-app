// Folder names as the mobile UI shows them. Plain JS (no component), so `t` is passed in.

const SPECIAL_KEYS = {
  '\\inbox': 'sidebar.inbox',
  '\\drafts': 'sidebar.drafts',
  '\\sent': 'mobile.folder.sent',
  '\\archive': 'common.archive',
  '\\junk': 'mobile.folder.junk',
  '\\trash': 'mobile.folder.trash',
};

/** The name the user sees: INBOX and special-use folders translated, others as the server names them. */
export function folderLabel(folder, t) {
  if (!folder) return '';
  if (folder.path.toUpperCase() === 'INBOX') return t('sidebar.inbox');
  const key = SPECIAL_KEYS[String(folder.specialUse || '').toLowerCase()];
  return key ? t(key) : folder.name || folder.path;
}
