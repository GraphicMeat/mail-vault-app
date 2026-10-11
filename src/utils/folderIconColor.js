// Folder icon colour. Three looks: a colour per folder role (default), one
// theme accent for all (`theme`), and a colour the user picked for one folder,
// which beats both.

export const FOLDER_ICON_PALETTE = [
  '#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308',
  '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#64748b',
];

const ROLE_COLORS = {
  INBOX: '#3b82f6',
  '\\Inbox': '#3b82f6',
  '\\Sent': '#0ea5e9',
  '\\Drafts': '#d946ef',
  '\\Trash': '#ef4444',
  '\\Junk': '#f59e0b',
  '\\Starred': '#eab308',
  '\\Important': '#f97316',
  '\\Archive': '#8b5cf6',
  '\\All': '#8b5cf6',
};
const PLAIN = '#14b8a6';
const LOCAL = '#22c55e';
const THEME = 'var(--mail-accent-text)';
const HEX = /^#[0-9a-f]{6}$/i;

export const defaultFolderColor = (node) => {
  if (node.local) return LOCAL;
  return ROLE_COLORS[node.specialUse] || ROLE_COLORS[node.path] || PLAIN;
};

export const folderColorKey = (accountId, path) => `${accountId}|${path}`;

export const folderIconColor = (node, { style, colors, accountId }) =>
  colors?.[folderColorKey(accountId, node.path)]
  || (style === 'theme' ? THEME : defaultFolderColor(node));

export const normalizeFolderIconStyle = (value) => (value === 'theme' ? 'theme' : 'colorful');

export const normalizeFolderIconColors = (value) => Object.fromEntries(
  Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
    .filter(([, color]) => typeof color === 'string' && HEX.test(color))
    .map(([key, color]) => [key, color.toLowerCase()]),
);
