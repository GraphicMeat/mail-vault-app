// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLocale } from '../../../i18n/index.js';
import en from '../../../i18n/locales/en.json';

afterEach(async () => { await setLocale('en'); });

// The page arrays live in the shared navigation manifest (SettingsPage.jsx re-exports them).
const SRC = readFileSync(resolve(process.cwd(), 'src/components/settings/settingsManifest.js'), 'utf8');

describe('settings tab labels', () => {
  it('stores a key, not a literal, in the module-level arrays', () => {
    expect(SRC.match(/label:\s*'[^']+'/g) || []).toEqual([]);
  });

  it('gives every labelKey a catalog entry', () => {
    const keys = [...SRC.matchAll(/labelKey:\s*'([^']+)'/g)].map(m => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(19);
    expect(keys.filter(k => !(k in en))).toEqual([]);
  });
});
