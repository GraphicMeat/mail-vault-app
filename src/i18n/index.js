import en from './locales/en.json';

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
