// @vitest-environment node
// The wheel file both apps render reaches no store, service, desktop i18n or Tauri module; the
// desktop wrapper (QuickActions.jsx) is what reaches them. Proven on the bundle esbuild builds
// (src/mobile/seam.js), so a transitive import counts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeSeam } from '../../mobile/seam.js';

const IMPURE = /src\/stores\/|src\/services\/|src\/i18n\/index|@tauri-apps/;
const file = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));

describe('the quick action wheel is presentational', () => {
  it('QuickActionsWheel.jsx reaches nothing desktop-bound', async () => {
    const r = await analyzeSeam(file('QuickActionsWheel.jsx'));
    expect(r.modules.filter((m) => !m.includes('node_modules/') && IMPURE.test(m))).toEqual([]);
    expect(r.rpcMethods).toEqual([]);
  });

  it('the check sees what the desktop wrapper reaches', async () => {
    const r = await analyzeSeam(file('QuickActions.jsx'));
    expect(r.modules.filter((m) => !m.includes('node_modules/') && IMPURE.test(m)).length).toBeGreaterThan(0);
  });

  // A touch never hovers: the phone lights the wedge under the finger with `data-hot`.
  it('a wedge lights by data-hot as it does by hover', () => {
    const css = readFileSync(fileURLToPath(new URL('../../styles/quick-actions.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.quick-action-radial-item\[data-hot\]:not\(:disabled\)/);
  });
});
