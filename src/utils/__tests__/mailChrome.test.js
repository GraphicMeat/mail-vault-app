import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getEmailColors } from '../mailChrome';
import { getDarkReaderInlineScripts } from '../darkReaderInject';

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
function injectedOptions(palette) {
  const script = getDarkReaderInlineScripts({ palette });
  return JSON.parse(script.match(/window\.DarkReader\.enable\((\{.*?\})\);/)[1]);
}
describe('email palette matches the app', () => {
  for (const palette of ['indigo', 'graphite']) {
    it(`uses ${palette}'s actual dark background and text for both HTML and plain text`, () => {
      const selector = palette === 'graphite' ? '[data-theme="dark"][data-palette="graphite"] {' : '[data-theme="dark"] {';
      const tokens = css.slice(css.indexOf(selector)).split('}')[0];
      const colors = getEmailColors('dark', palette);
      expect(colors.background).toBe(tokens.match(/--mail-bg:\s*(#[\da-f]+)/)[1]);
      expect(colors.text).toBe(tokens.match(/--mail-text:\s*(#[\da-f]+)/)[1]);
      expect(injectedOptions(palette)).toMatchObject({ darkSchemeBackgroundColor: colors.background, darkSchemeTextColor: colors.text, contrast: 100, brightness: 100 });
      expect(injectedOptions(palette)).not.toHaveProperty('palette');
    });
  }
  it('keeps original light paper and handles older settings without a palette', () => {
    expect(getEmailColors('light', 'graphite')).toEqual({ background: '#ffffff', text: '#333333' });
    expect(getEmailColors('dark', 'unknown')).toEqual(getEmailColors('dark', 'indigo'));
  });
});
