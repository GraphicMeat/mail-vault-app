// Email mode is independent of app mode. Keep both dark palettes here because
// a dark message inside a light app cannot read the app's current CSS values.
// The palette contrast tests also compare these tokens with styles/index.css.
const DARK_EMAIL_COLORS = {
  indigo: { background: '#0a0a12', text: '#e8e8ef' },
  graphite: { background: '#121313', text: '#edece7' },
  teal: { background: '#0a1517', text: '#e6f1f2' },
};
const LIGHT_EMAIL_COLORS = { background: '#ffffff', text: '#333333' };

export function getEmailColors(theme = 'dark', palette = 'indigo') {
  return theme === 'dark' ? (DARK_EMAIL_COLORS[palette] || DARK_EMAIL_COLORS.indigo) : LIGHT_EMAIL_COLORS;
}

// Default fallbacks for the chat frame's live CSS tokens.
export const MAIL_DARK_BG = DARK_EMAIL_COLORS.indigo.background;
export const MAIL_DARK_TEXT = DARK_EMAIL_COLORS.indigo.text;

// Chat bubble links live in an isolated frame, so they cannot read the app's
// tokens. Indigo and graphite keep the original indigo links; teal gets links
// that stay readable on its own bubbles (see chatLinkColors.test.js).
const INDIGO_CHAT_LINKS = { sent: '#c7d2fe', received: '#6366f1' };
export function getChatLinkColors(palette, theme = 'dark') {
  if (palette !== 'teal') return INDIGO_CHAT_LINKS;
  return { sent: '#b6ecf2', received: theme === 'dark' ? '#86dfe9' : '#08596b' };
}
