// The pure half of `t()`: catalog lookup with plural selection, and `{{var}}` interpolation.
// No store, no locale state: the caller passes the catalog, the English fallback and the locale.
// `src/i18n/index.js` (desktop, with its settings-store locale switching) and the mobile shell
// (`src/mobile/i18n.js`) both translate through here.

export const interpolate = (s, vars) =>
  vars ? s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;

/**
 * The catalog string for `key`, before interpolation. With a numeric `vars.count` the plural
 * form for `locale` wins, then `_other`, each from `catalog` before `fallback`. A key in neither
 * comes back as the key itself.
 */
export function lookup(catalog, fallback, locale, key, vars) {
  if (vars && typeof vars.count === 'number') {
    const cat = new Intl.PluralRules(locale).select(vars.count);
    const hit = catalog[`${key}_${cat}`] ?? fallback[`${key}_${cat}`]
             ?? catalog[`${key}_other`] ?? fallback[`${key}_other`];
    if (hit !== undefined) return hit;
  }
  return catalog[key] ?? fallback[key] ?? key;
}

export function translate(catalog, fallback, locale, key, vars) {
  return interpolate(lookup(catalog, fallback, locale, key, vars), vars);
}
