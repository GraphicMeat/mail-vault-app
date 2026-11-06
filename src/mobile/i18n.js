// Mobile `t()`. Same catalog and the same lookup as `src/i18n/index.js`, which the mobile bundle
// cannot import: it pulls in the desktop settings store (and with it desktop RPCs) for language
// switching. Plan 1 is English only; a parity test keeps this in step with desktop `t()`.
import en from '../i18n/locales/en.json';

const interp = (s, vars) =>
  vars ? s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;

function resolve(key, vars) {
  if (vars && typeof vars.count === 'number') {
    const cat = new Intl.PluralRules('en').select(vars.count);
    const hit = en[`${key}_${cat}`] ?? en[`${key}_other`];
    if (hit !== undefined) return hit;
  }
  return en[key] ?? key;
}

export function t(key, vars) {
  return interp(resolve(key, vars), vars);
}

/**
 * Desktop components call `useT()` so a language switch repaints them. Mobile has one language
 * in Plan 1, so there is nothing to subscribe to yet; components still take `t` from here, which
 * is where a switch would hook in.
 */
export function useT() {
  return t;
}
