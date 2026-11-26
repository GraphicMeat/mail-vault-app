// @vitest-environment node
// The colour tile behind every settings navigation icon: one colour per entry (the manifest's
// SETTINGS_TILE_COLORS). The tile hues stay clear of the custody colours (DESIGN.md, Four Roles
// Rule): vault emerald, server blue and only-copy gold keep their meaning.
import { describe, expect, it } from 'vitest';
import { readStyleSheet } from '../../../styles/__tests__/readStyleSheet.js';
import { contrast, deltaE, tokens } from '../../../utils/__tests__/colorMath';
import { allTabs, settingsHosts, settingsSections, footerTabs, SETTINGS_TILE_COLORS, settingsTileColor } from '../settingsManifest';

const css = readStyleSheet(new URL('../../../styles/index.css', import.meta.url));
const FLOOR = 5.5;

describe('tile colours', () => {
  const ids = [...new Set([...allTabs.map((tab) => tab.id), ...Object.keys(settingsHosts)])];

  it('every page and host has its own colour, as a hex', () => {
    for (const id of ids) expect(SETTINGS_TILE_COLORS[id], id).toMatch(/^#[0-9a-f]{6}$/);
    expect(settingsSections.length).toBeGreaterThan(0);
    expect(footerTabs.map((tab) => tab.id)).toEqual(['billing', 'diagnostics', 'help']);
  });

  it('an unknown id still gets a neutral tile', () => {
    expect(settingsTileColor('nope')).toMatch(/^#[0-9a-f]{6}$/);
    expect(settingsTileColor('appearance')).toBe(SETTINGS_TILE_COLORS.appearance);
  });

  it('holds a white glyph at 3:1 or better', () => {
    for (const [id, color] of Object.entries(SETTINGS_TILE_COLORS)) {
      expect(contrast(color, '#ffffff'), id).toBeGreaterThanOrEqual(3);
    }
  });

  for (const mode of ['dark', 'light']) {
    it(`keeps every tile clear of vault, server and only-copy in the ${mode} theme`, () => {
      const t = tokens(css, `[data-theme="${mode}"] {`);
      for (const custody of ['local', 'server', 'only-copy']) {
        expect(t[custody], custody).toBeTruthy();
        for (const [id, color] of Object.entries(SETTINGS_TILE_COLORS)) {
          expect(deltaE(color, t[custody]), `${id} vs ${custody}`).toBeGreaterThanOrEqual(FLOOR);
        }
      }
    });
  }
});

