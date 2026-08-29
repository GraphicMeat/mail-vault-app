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

export function t(key, vars) {
  return _interp(_catalog[key] ?? en[key] ?? key, vars);
}
