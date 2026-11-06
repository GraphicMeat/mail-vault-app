// Mobile `t()`: the shared catalog lookup (`src/i18n/core.js`) over the catalog of the system
// language, English per missing key. Desktop `src/i18n/index.js` cannot be imported here: its
// language switching lives in the desktop settings store, which would bring desktop RPCs into the
// mobile bundle. The language is picked once at launch (`loadMobileLocale`, awaited before the
// first render), so components never see it change and there is nothing to subscribe to.
import en from '../i18n/locales/en.json';
import { translate } from '../i18n/core.js';

/** The nine app languages. Only these codes ever reach `Intl`, never a raw system tag. */
export const MOBILE_LOCALES = ['en', 'es', 'fr', 'it', 'de', 'pt-BR', 'ja', 'ko', 'zh-Hans'];

// Literal specifiers, so Vite emits one chunk per language and loads only the one in use.
const LOADERS = {
  es: () => import('../i18n/locales/es.json'),
  fr: () => import('../i18n/locales/fr.json'),
  it: () => import('../i18n/locales/it.json'),
  de: () => import('../i18n/locales/de.json'),
  'pt-BR': () => import('../i18n/locales/pt-BR.json'),
  ja: () => import('../i18n/locales/ja.json'),
  ko: () => import('../i18n/locales/ko.json'),
  'zh-Hans': () => import('../i18n/locales/zh-Hans.json'),
};

let locale = 'en';
let catalog = en;

/** The first system language we have a catalog for (`pt-*` reads Brazilian, `zh-*` Simplified). */
export function pickLocale(languages) {
  for (const tag of Array.isArray(languages) ? languages : []) {
    const base = String(tag).toLowerCase().split(/[-_]/)[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'zh') return 'zh-Hans';
    const hit = MOBILE_LOCALES.find((code) => code === base);
    if (hit) return hit;
  }
  return 'en';
}

function systemLanguages() {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** Loads the catalog for `languages` (the system's by default). English if anything fails. */
export async function loadMobileLocale(languages = systemLanguages()) {
  const code = pickLocale(languages);
  if (code === 'en') {
    locale = 'en';
    catalog = en;
    return locale;
  }
  try {
    const mod = await LOADERS[code]();
    catalog = mod.default ?? mod;
    locale = code;
  } catch {
    catalog = en;
    locale = 'en';
  }
  return locale;
}

export function getMobileLocale() {
  return locale;
}

export function t(key, vars) {
  return translate(catalog, en, locale, key, vars);
}

/** Components take `t` from here; the language is fixed for the life of the page. */
export function useT() {
  return t;
}
