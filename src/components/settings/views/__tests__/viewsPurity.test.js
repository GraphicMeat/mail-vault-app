// @vitest-environment node
// A settings view is rendered by both apps, so the phone bundle reaches everything it imports.
// Each view, and the manifest, must reach no store, no service, no desktop i18n (it imports the
// settings store), no hook module and no Tauri API, and name no RPC method or command. Proven on
// the bundle esbuild builds from each one (src/mobile/seam.js), so a transitive import counts.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeSeam } from '../../../../mobile/seam.js';

const dir = fileURLToPath(new URL('..', import.meta.url));
const VIEWS = readdirSync(dir).filter((f) => f.endsWith('.jsx')).map((f) => `${dir}${f}`);
const MANIFEST = fileURLToPath(new URL('../../settingsManifest.js', import.meta.url));
const IMPURE = /src\/stores\/|src\/services\/|src\/i18n\/index|src\/hooks\/|@tauri-apps|src\/mobile\//;

describe('settings views are pure', () => {
  it('there are views to check', () => {
    expect(VIEWS.length).toBeGreaterThan(5);
  });

  for (const file of [...VIEWS, MANIFEST]) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    it(`${name} reaches no store, service, desktop i18n, hook or Tauri module`, async () => {
      const r = await analyzeSeam(file);
      expect(r.modules.filter((m) => !m.includes('node_modules/') && IMPURE.test(m))).toEqual([]);
      expect(r.modules.filter((m) => /node_modules\/@tauri-apps/.test(m))).toEqual([]);
      expect(r.rpcMethods).toEqual([]);
      expect(r.invokes).toEqual([]);
      expect(r.dynamicCalls).toEqual([]);
    });
  }

  it('the check really detects a store', async () => {
    const r = await analyzeSeam(fileURLToPath(new URL('../../AppearanceSettings.jsx', import.meta.url)));
    expect(r.modules.filter((m) => IMPURE.test(m)).length).toBeGreaterThan(0);
  });
});
