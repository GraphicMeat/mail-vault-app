import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import appConfig from '../../vite.config.js';
import demoConfig from '../../vite.demo.config.js';

// The app CSP has `font-src 'self'` with no `data:`, so a font Vite inlines
// into the CSS as a data: URL (anything under the 4KB default) is blocked and
// its glyphs never draw. Every bundled font must ship as a file.
const FONTS_DIR = resolve(process.cwd(), 'src/assets/fonts');
const fonts = readdirSync(FONTS_DIR).map(name => resolve(FONTS_DIR, name));

describe.each([
  ['vite.config.js', appConfig],
  ['vite.demo.config.js', demoConfig],
])('%s', (_name, config) => {
  const limit = config.build?.assetsInlineLimit;

  it('never inlines a bundled font as a data: URL', () => {
    expect(typeof limit).toBe('function');
    for (const file of fonts) {
      expect(limit(file, readFileSync(file)), file).toBe(false);
    }
  });

  it('leaves other assets to the default inline rule', () => {
    expect(limit('/x/icon.svg', Buffer.alloc(10))).toBeUndefined();
  });
});
