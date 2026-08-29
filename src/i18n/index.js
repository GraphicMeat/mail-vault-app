import en from './locales/en.json';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * The active catalog is module state, not React state, so `t()` works from
 * services, stores and plain functions — anywhere an error message is built.
 * `en` is imported statically and is always the fallback: that is what lets
 * every existing render test call `t()` with no provider mounted.
 */
let _locale = 'en';
let _catalog = en;

const _interp = (s, vars) =>
  vars ? s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;

/**
 * `_locale` is always one of our nine hardcoded codes, never `navigator.language`
 * — so unlike `dateFormat.js` this needs no BCP 47 validation. See
 * `reference_webkitgtk_c_locale_intl_crash` for why that distinction matters.
 */
function _resolve(key, vars) {
  if (vars && typeof vars.count === 'number') {
    const cat = new Intl.PluralRules(_locale).select(vars.count);
    const hit = _catalog[`${key}_${cat}`] ?? en[`${key}_${cat}`]
             ?? _catalog[`${key}_other`] ?? en[`${key}_other`];
    if (hit !== undefined) return hit;
  }
  return _catalog[key] ?? en[key] ?? key;
}

export function t(key, vars) {
  return _interp(_resolve(key, vars), vars);
}

export const LOCALES = [
  { code: 'en',      flag: '🇬🇧', native: 'English',             english: 'English' },
  { code: 'es',      flag: '🇪🇸', native: 'Español',             english: 'Spanish' },
  { code: 'fr',      flag: '🇫🇷', native: 'Français',            english: 'French' },
  { code: 'it',      flag: '🇮🇹', native: 'Italiano',            english: 'Italian' },
  { code: 'de',      flag: '🇩🇪', native: 'Deutsch',             english: 'German' },
  { code: 'pt-BR',   flag: '🇧🇷', native: 'Português (Brasil)',  english: 'Portuguese (Brazil)' },
  { code: 'ja',      flag: '🇯🇵', native: '日本語',                english: 'Japanese' },
  { code: 'ko',      flag: '🇰🇷', native: '한국어',                english: 'Korean' },
  { code: 'zh-Hans', flag: '🇨🇳', native: '简体中文',              english: 'Chinese (Simplified)' },
];

// Static map, not `import(`./locales/${code}.json`)` — Vite needs the literal
// specifiers to emit one chunk per locale.
const _loaders = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  it: () => import('./locales/it.json'),
  de: () => import('./locales/de.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  'zh-Hans': () => import('./locales/zh-Hans.json'),
};

export const getLocale = () => _locale;

/**
 * Load first, publish second. Writing the store field is what re-renders every
 * subscriber, so it must happen only once `_catalog` already holds the new
 * language — otherwise the repaint reads the old catalog and the switch looks
 * like it did nothing until some unrelated render happens to come along.
 */
export async function setLocale(code) {
  if (code === 'en' || !_loaders[code]) {
    _catalog = en;
    _locale = 'en';
  } else {
    const mod = await _loaders[code]();
    _catalog = mod.default;
    _locale = code;
  }
  useSettingsStore.setState({ language: _locale });
}

/**
 * `t` is a stable module function; the re-render comes from subscribing to the
 * store field, not from a new identity. That also means a `React.memo`
 * component with no props still repaints, because the hook lives inside it.
 */
export function useT() {
  useSettingsStore(s => s.language);
  return t;
}
