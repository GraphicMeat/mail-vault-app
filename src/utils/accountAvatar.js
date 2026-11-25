// An account's avatar: its initial(s) on its colour. Kept out of the store so
// pure UI modules (and tests that mock the store) can draw an account too.

export const AVATAR_COLORS = [
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#64748b', // slate
  '#d946ef', // fuchsia
  '#f43f5e', // rose
];

// Deterministic color from email string
export function hashColor(email) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash) + email.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// Get the initial letter(s) for an account avatar
export function getAccountInitial(account, displayName) {
  const name = displayName || account.name;
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name[0].toUpperCase();
  }
  return (account.email || '?')[0].toUpperCase();
}

// Get avatar color for an account (user override or deterministic)
export function getAccountColor(accountColors, account) {
  return accountColors[account.id] || hashColor(account.email || account.id);
}
