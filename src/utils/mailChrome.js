// Email mode is independent of app mode. Keep both dark palettes here because
// a dark message inside a light app cannot read the app's current CSS values.
// The palette contrast tests also compare these tokens with styles/index.css.
const DARK_EMAIL_COLORS = {
  indigo: { background: '#0a0a12', text: '#e8e8ef' },
  graphite: { background: '#121313', text: '#edece7' },
};
const LIGHT_EMAIL_COLORS = { background: '#ffffff', text: '#333333' };

export function getEmailColors(theme = 'dark', palette = 'indigo') {
  return theme === 'dark' ? (DARK_EMAIL_COLORS[palette] || DARK_EMAIL_COLORS.indigo) : LIGHT_EMAIL_COLORS;
}

// Default fallbacks for the chat frame's live CSS tokens.
export const MAIL_DARK_BG = DARK_EMAIL_COLORS.indigo.background;
export const MAIL_DARK_TEXT = DARK_EMAIL_COLORS.indigo.text;
