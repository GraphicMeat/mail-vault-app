// Mobile `t()`: the shared catalog lookup (`src/i18n/core.js`) over the catalog of the app
// language, English per missing key. Desktop `src/i18n/index.js` cannot be imported here: its
// language switching lives in the desktop settings store, which would bring desktop RPCs into the
// mobile bundle. The language is the one the user picked on the tour (engine setting `language`),
// else the system's; it is read once at launch (`startMobileLocale`, awaited before the first
// render). Picking another on the tour loads that catalog and tells the subscribers: `useT()`
// re-renders every component that uses it, so the page changes language in place.
import { useSyncExternalStore } from 'react';
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
// Bumped on each language change; `useT` re-renders on it.
let version = 0;
// The latest load's number: an older load that finishes later is dropped (the last pick wins).
let loadSeq = 0;
const listeners = new Set();

function changed(code, cat) {
  if (code === locale && cat === catalog) return;
  locale = code;
  catalog = cat;
  version += 1;
  for (const fn of listeners) fn();
}

/** Calls `fn` after each language change. Returns the unsubscribe. */
export function subscribeLocale(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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

/**
 * Loads the catalog for `stored` (the user's pick, when it is one of the nine) or else for
 * `languages` (the system's by default). English if anything fails.
 */
export async function loadMobileLocale(languages = systemLanguages(), stored = null) {
  const seq = ++loadSeq;
  const code = MOBILE_LOCALES.includes(stored) ? stored : pickLocale(languages);
  let next = en;
  let nextCode = 'en';
  if (code !== 'en') {
    try {
      const mod = await LOADERS[code]();
      next = mod.default ?? mod;
      nextCode = code;
    } catch {
      // English, below.
    }
  }
  if (seq === loadSeq) changed(nextCode, next);
  return locale;
}

/**
 * The launch: the stored language (`readSettings()` answers the engine's `mobile.settings.get`)
 * over the system's. A failing or slow engine (more than `waitMs`) leaves the system's: the
 * first paint never waits long on it.
 */
export async function startMobileLocale(readSettings, languages = systemLanguages(), waitMs = 1500) {
  let stored = null;
  let timer;
  let late = false;
  const read = Promise.resolve().then(readSettings);
  try {
    const settings = await Promise.race([
      read,
      new Promise((resolve) => { timer = setTimeout(() => { late = true; resolve(null); }, waitMs); }),
    ]);
    stored = settings?.language ?? null;
  } catch {
    stored = null;
  } finally {
    clearTimeout(timer);
  }
  const first = loadMobileLocale(languages, stored);
  if (late) {
    // The engine answered after the first paint: its stored language still wins (the page
    // switches live), unless a language was picked meanwhile.
    const seq = loadSeq;
    read.then(
      (settings) => {
        const language = settings?.language;
        if (seq === loadSeq && MOBILE_LOCALES.includes(language)) loadMobileLocale(languages, language);
      },
      () => {},
    );
  }
  return first;
}

export function getMobileLocale() {
  return locale;
}

export function t(key, vars) {
  return translate(catalog, en, locale, key, vars);
}

const getVersion = () => version;

/** Components take `t` from here; they re-render when the language changes. */
export function useT() {
  useSyncExternalStore(subscribeLocale, getVersion, getVersion);
  return t;
}
