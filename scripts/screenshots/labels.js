/**
 * Resolve the app's own UI strings for the harness, node-side.
 *
 * The alternative — reading them out of the running app through `__I18N__` —
 * needs the VITE_E2E build and a round trip per label. The catalogs are JSON on
 * disk, so reading them here keeps every finder synchronous and leaves the app
 * untouched.
 *
 * A missing key throws. A finder that silently resolves to `undefined` clicks
 * nothing, and the run then photographs whatever was already on screen — the
 * exact failure the harness's "assert the screen you photograph" rule exists to
 * prevent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '../../src/i18n/locales');

// Catalogs are flat: keys are dotted strings, not nested objects.
const load = (code) => JSON.parse(readFileSync(join(DIR, `${code}.json`), 'utf-8'));

export function makeLabels(code) {
  const en = load('en');
  const loc = code === 'en' ? en : load(code);
  return function L(key) {
    const hit = loc[key] ?? en[key];
    if (typeof hit !== 'string') throw new Error(`unknown label key: ${key}`);
    return hit;
  };
}
