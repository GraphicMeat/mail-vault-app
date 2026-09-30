// The faces a signature's font control offers, each with the stack written
// into the signature (utils/googleFonts.js has the downloaded ones).

import { APP_FONTS } from './appFont';
import { EMAIL_FALLBACK, cssFamilyName, emailFontStack } from './googleFonts';

// Faces a signature may name besides the catalogue: the web-safe families
// most mail clients have, then the ones the app bundles (they draw here;
// recipients see the fallback, as with a Google font).
const WEB_SAFE = [
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Helvetica', 'Helvetica, Arial, sans-serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Tahoma', 'Tahoma, Verdana, sans-serif'],
  ['Trebuchet MS', "'Trebuchet MS', Helvetica, sans-serif"],
  ['Georgia', "Georgia, 'Times New Roman', serif"],
  ['Times New Roman', "'Times New Roman', Times, serif"],
  ['Garamond', "Garamond, Georgia, serif"],
  ['Courier New', "'Courier New', Courier, monospace"],
];

export const SIGNATURE_FONTS = [
  ...WEB_SAFE.map(([family, stack]) => ({ family, stack, kind: 'webSafe' })),
  ...APP_FONTS.filter(font => font.family).map(font => ({
    family: font.family,
    stack: `${cssFamilyName(font.family)}, ${EMAIL_FALLBACK[font.mono ? 'mono' : 'sans']}`,
    kind: 'bundled',
  })),
];

/** The stack a signature is written with for `family` ('' when unknown). */
export function signatureFontStack(family) {
  return SIGNATURE_FONTS.find(font => font.family === family)?.stack || emailFontStack(family);
}
