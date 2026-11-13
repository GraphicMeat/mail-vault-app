// An account's colour, as desktop gives it: the account's own colour when it has one, else one
// hashed from its address over desktop's palette, so an account keeps one colour on both apps.
// The palette is desktop's `AVATAR_COLORS` (src/stores/settingsStore.js), copied because the
// mobile bundle may not import a desktop store; a test keeps the two equal.

export const ACCOUNT_COLORS = [
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#64748b', // slate
  '#d946ef', // fuchsia
  '#f43f5e', // rose
];

/** Desktop's `hashColor`: the same address gets the same colour. */
function hashColor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length];
}

/** The colour that marks `account`'s rows in All Inboxes. */
export function accountColor(account) {
  if (account?.color) return account.color;
  return hashColor(String(account?.email || account?.id || ''));
}
