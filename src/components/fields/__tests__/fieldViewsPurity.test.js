// @vitest-environment node
// The field views are rendered by both apps, so the phone bundle reaches everything they import:
// like the settings views (settings/views/__tests__/viewsPurity.test.js), they reach no store, no
// service, no desktop i18n, no hook module and no Tauri API, and name no RPC method or command.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeSeam } from '../../../mobile/seam.js';

const dir = fileURLToPath(new URL('..', import.meta.url));
const VIEWS = readdirSync(dir).filter((f) => f.endsWith('.jsx')).map((f) => `${dir}${f}`);
const IMPURE = /src\/stores\/|src\/services\/|src\/i18n\/index|src\/hooks\/|@tauri-apps|src\/mobile\//;

describe('field views are pure', () => {
  it('there are views to check', () => {
    expect(VIEWS.length).toBeGreaterThan(0);
  });

  for (const file of VIEWS) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    it(`${name} reaches no store, service, desktop i18n, hook or Tauri module`, async () => {
      const r = await analyzeSeam(file);
      expect(r.modules.filter((m) => !m.includes('node_modules/') && IMPURE.test(m))).toEqual([]);
      expect(r.rpcMethods).toEqual([]);
      expect(r.invokes).toEqual([]);
      expect(r.dynamicCalls).toEqual([]);
    });
  }

  it('the check really detects a store', async () => {
    const r = await analyzeSeam(fileURLToPath(new URL('../../FieldStrip.jsx', import.meta.url)));
    expect(r.modules.filter((m) => IMPURE.test(m)).length).toBeGreaterThan(0);
  });
});
