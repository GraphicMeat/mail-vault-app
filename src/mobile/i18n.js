// Mobile `t()`: the shared catalog lookup (`src/i18n/core.js`) over the English catalog. Desktop
// `src/i18n/index.js` cannot be imported here: its language switching lives in the desktop
// settings store, which would bring desktop RPCs into the mobile bundle. Plan 1 is English only.
import en from '../i18n/locales/en.json';
import { translate } from '../i18n/core.js';

export const MOBILE_LOCALE = 'en';

export function t(key, vars) {
  return translate(en, en, MOBILE_LOCALE, key, vars);
}

/**
 * Desktop components call `useT()` so a language switch repaints them. Mobile has one language
 * in Plan 1, so there is nothing to subscribe to yet; components still take `t` from here, which
 * is where a switch would hook in.
 */
export function useT() {
  return t;
}
