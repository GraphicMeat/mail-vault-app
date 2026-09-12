/**
 * Browser-demo locale boundaries.  Keep this module dependency-free: the
 * persistence bootstrap imports it before React, settings, and the app are
 * loaded.
 */
export const DEMO_LOCALES = Object.freeze([
  'en', 'de', 'fr', 'es', 'it', 'pt-BR', 'ja', 'ko', 'zh-Hans',
]);

const SITE_DIRS = Object.freeze({
  en: '',
  de: 'de',
  fr: 'fr',
  es: 'es',
  it: 'it',
  'pt-BR': 'pt-br',
  ja: 'ja',
  ko: 'ko',
  'zh-Hans': 'zh',
});

const LOCALE_SET = new Set(DEMO_LOCALES);
const SITE_DIR_SET = new Set(Object.values(SITE_DIRS).filter(Boolean));

/** Return an app locale only when value is one of the supported codes. */
export function normalizeDemoLocale(value) {
  return typeof value === 'string' && LOCALE_SET.has(value) ? value : null;
}

/**
 * Read only an explicit `?lang=` value.  Callers decide whether a missing
 * value should use persisted settings or English; this helper never does.
 */
export function demoLocaleFromLocation(location = globalThis.location) {
  const search = typeof location?.search === 'string' ? location.search : '';
  if (!search) return null;
  try {
    return normalizeDemoLocale(new URLSearchParams(search).get('lang'));
  } catch {
    return null;
  }
}

function stripSiteLocale(pathname) {
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const match = withSlash.match(/^\/([^/]+)(?=\/|$)/);
  if (match && SITE_DIR_SET.has(match[1])) return withSlash.slice(match[0].length) || '/';
  return withSlash;
}

/**
 * Convert a website path to the selected locale directory while retaining its
 * query and hash.  Invalid languages intentionally resolve to the English
 * site, so an untrusted query cannot manufacture a path or import target.
 */
export function demoSitePath(path, language) {
  const raw = typeof path === 'string' && path ? path : '/';
  const splitAt = raw.search(/[?#]/);
  const pathname = splitAt < 0 ? raw : raw.slice(0, splitAt);
  const suffix = splitAt < 0 ? '' : raw.slice(splitAt);
  const cleanPath = stripSiteLocale(pathname);
  const locale = normalizeDemoLocale(language) || 'en';
  const dir = SITE_DIRS[locale];
  return `${dir ? `/${dir}` : ''}${cleanPath === '/' ? '/' : cleanPath}${suffix}`;
}

export function demoSiteLocaleDirectory(language) {
  const locale = normalizeDemoLocale(language) || 'en';
  return SITE_DIRS[locale];
}
