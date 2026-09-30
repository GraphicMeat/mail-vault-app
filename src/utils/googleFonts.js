// ── googleFonts — the curated Google Fonts catalogue and the stacks built on it ──
//
// The catalogue is bundled (data/googleFonts.json, the same file the daemon
// checks every download against), so browsing needs no network. A family is
// downloaded once, by the daemon, only when chosen (services/fontService.js).
//
// Two fallbacks per category: the app's UI falls back to system faces; a
// signature falls back to faces every mail client has, because recipients
// generally cannot load web fonts and see the fallback.

import catalogue from '../data/googleFonts.json';

export const GOOGLE_FONTS = catalogue.families;
export const GOOGLE_FONT_CATEGORIES = ['sans', 'serif', 'mono', 'display', 'handwriting'];
const PREFIX = 'google:';

export const findGoogleFont = family => GOOGLE_FONTS.find(font => font.family === family) || null;
export const googleFontId = family => `${PREFIX}${family}`;
export const googleFamilyOf = id => (typeof id === 'string' && id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null);

export function searchGoogleFonts(query = '', category = null) {
  const needle = query.trim().toLowerCase();
  return GOOGLE_FONTS.filter(font => (!category || font.category === category)
    && (!needle || font.family.toLowerCase().includes(needle)));
}

const UI_FALLBACK = {
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
  display: 'system-ui, sans-serif',
  handwriting: 'system-ui, sans-serif',
};

export const EMAIL_FALLBACK = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', monospace",
  display: 'Arial, Helvetica, sans-serif',
  handwriting: "Georgia, 'Times New Roman', serif",
};

/** The app's UI stack for a catalogue family ('' for any other). */
export function uiFontStack(family) {
  const font = findGoogleFont(family);
  return font ? `'${font.family}', ${UI_FALLBACK[font.category]}` : '';
}

// A family name in a stack: quoted only when it is not a plain word. The
// editor rewrites a signature's list into its own form (utils/fontFamilyMark.js).
export const cssFamilyName = name => (/^-?[A-Za-z][A-Za-z-]*$/.test(name) ? name : `'${name}'`);

/** A signature's stack for a catalogue family ('' for any other). */
export function emailFontStack(family) {
  const font = findGoogleFont(family);
  return font ? `${cssFamilyName(font.family)}, ${EMAIL_FALLBACK[font.category]}` : '';
}
