// ── mailFonts — the Google Fonts a received mail is written in ──
//
// A mail styled in a Google Font links Google's stylesheet. Left in, the
// webview fetches it and the font files itself: past Network Activity, and
// past tracker blocking. stripGoogleFontImports takes those links out of every
// framed body (stores/netActivityStore.js frameBody); the families the mail
// chose come from the daemon instead (services/fontService.js attachMailFonts),
// read off the rendered frame with fontSourcesOf + mailFontFamilies.

import { GOOGLE_FONTS } from './googleFonts';

// More than this in one message is decoration, not a typeface worth fetching.
export const MAX_MAIL_FONTS = 4;

const FONT_HOST = /^\s*(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com(?:[/?#:]|\s*$)/i;
const LINK_TAG = /<link\b[^>]*>/gi;
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
// The URL runs to its closing quote or paren: a css2 query carries `;`
// (`wght@400;700`). Then any media list, up to the rule's `;`.
const IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)|"([^"]*)"|'([^']*)')[^;{}]*;?/gi;

const urlOf = match => match.slice(1).find(part => part !== undefined) || '';

/** The mail's HTML without the links and @imports that load Google Fonts. */
export function stripGoogleFontImports(html) {
  if (!html || !/fonts\.(?:googleapis|gstatic)\.com/i.test(html)) return html;
  return html
    .replace(LINK_TAG, tag => {
      const href = tag.match(HREF);
      return href && FONT_HOST.test(urlOf(href)) ? '' : tag;
    })
    .replace(IMPORT, (rule, ...parts) => (FONT_HOST.test(urlOf([rule, ...parts.slice(0, 5)])) ? '' : rule));
}

const CATALOGUE = new Map(GOOGLE_FONTS.map(font => [font.family.toLowerCase(), font.family]));

// `font-family:` and the `font:` shorthand, never a longhand like font-size.
const FONT_PROP = /(^|[^-\w])(font-family|font)\s*:\s*([^;{}]*)/gi;
// The shorthand's family list follows its size (and optional /line-height). A
// unitless number is a weight, not a size; a value with no size is a system
// font keyword (caption, -apple-system-body) and names no family.
const SHORTHAND_FAMILY = /(?:^|\s)(?:\+?\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|%|vw|vh|vmin|vmax|cm|mm|in|q)|0|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)(?:\s*\/\s*[^\s,"']+)?\s+(\S.*)$/i;

// The first family of a stack: the one the author chose. Later ones are
// fallbacks (a system stack names Roboto for Android, not as a request).
function firstFamily(list) {
  const value = list.replace(/\s*!\s*important\s*$/i, '').trim();
  const quoted = value.match(/^(["'])(.*?)\1/);
  return (quoted ? quoted[2] : value.split(',')[0]).trim().replace(/\s+/g, ' ');
}

function familyOf(prop, value) {
  if (prop.toLowerCase() === 'font-family') return firstFamily(value);
  const rest = value.trim().match(SHORTHAND_FAMILY);
  return rest ? firstFamily(rest[1]) : '';
}

/**
 * The catalogue families (catalogue spelling) a mail chose: the first family
 * of each `font-family` and `font` declaration in `cssTexts`, and of each
 * `<font face>` in `faceNames`. Deduped, at most MAX_MAIL_FONTS.
 */
export function mailFontFamilies(cssTexts = [], faceNames = []) {
  const found = [];
  const take = name => {
    const family = CATALOGUE.get(name.toLowerCase());
    if (family && !found.includes(family)) found.push(family);
    return found.length >= MAX_MAIL_FONTS;
  };
  for (const css of cssTexts) {
    if (!css || !/font/i.test(css)) continue;
    for (const [, , prop, value] of css.matchAll(FONT_PROP)) {
      if (take(familyOf(prop, value))) return found;
    }
  }
  for (const face of faceNames) {
    if (face && take(firstFamily(face))) return found;
  }
  return found;
}

/** `[cssTexts, faceNames]` of a rendered document, for mailFontFamilies. */
export function fontSourcesOf(doc) {
  const css = [...doc.querySelectorAll('style')].map(style => style.textContent || '');
  for (const el of doc.querySelectorAll('[style]')) css.push(el.getAttribute('style') || '');
  const faces = [...doc.querySelectorAll('font[face]')].map(el => el.getAttribute('face') || '');
  return [css, faces];
}
