import { describe, it, expect } from 'vitest';
import { blitzThemeFor } from '../themeInputs';
import { getDarkReaderInlineScripts } from '../../../../utils/darkReaderInject';

const drOptions = (palette) => {
  const html = getDarkReaderInlineScripts({ palette, nonce: '' });
  const all = [...html.matchAll(/DarkReader\.enable\((\{[^)]*\})\)/g)];
  return JSON.parse(all[all.length - 1][1]);
};

describe('blitzThemeFor', () => {
  for (const palette of ['indigo', 'graphite', 'teal']) {
    it(`sends the same Dark Reader options the iframe enables (${palette})`, () => {
      const dr = drOptions(palette);
      expect(blitzThemeFor({ dark: true, palette })).toEqual({
        mode: 'dark',
        bg: dr.darkSchemeBackgroundColor,
        fg: dr.darkSchemeTextColor,
        brightness: dr.brightness,
        contrast: dr.contrast,
        sepia: dr.sepia,
      });
    });
  }
  it('light sends light', () => {
    expect(blitzThemeFor({ dark: false, palette: 'teal' })).toEqual({ mode: 'light' });
  });
});
