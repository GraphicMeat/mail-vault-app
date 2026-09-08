import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../styles/index.css', import.meta.url), 'utf8');
const tokens = selector => Object.fromEntries([...css.slice(css.indexOf(selector)).split('}')[0]
  .matchAll(/--mail-([\w-]+):\s*(#[\da-f]+)/g)].map(match => [match[1], match[2]]));
function luminance(hex) {
  const [r, g, b] = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}
for (const mode of ['dark', 'light']) {
  for (const palette of ['indigo', 'graphite']) {
    describe(`${mode} ${palette}`, () => {
      const base = tokens(`[data-theme="${mode}"] {`);
      const theme = { ...base, ...(palette === 'graphite' ? tokens(`[data-theme="${mode}"][data-palette="graphite"] {`) : {}) };
      it('keeps text legible on ordinary, hovered, and selected surfaces', () => {
        for (const background of ['bg', 'surface', 'surface-hover', 'row-selected']) {
          for (const foreground of ['text', 'text-muted', 'accent-text']) {
            expect(contrast(theme[foreground], theme[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });
      it('keeps white action labels readable at rest and on hover', () => {
        for (const token of ['accent-fill', 'accent-hover', 'danger-fill', 'danger-hover']) expect(contrast('#ffffff', theme[token])).toBeGreaterThanOrEqual(4.5);
      });
      it('preserves custody/status colors and visible control boundaries', () => {
        for (const token of ['local', 'server', 'only-copy', 'danger', 'warning', 'success']) expect(theme[token]).toBe(base[token]);
        expect(contrast(theme['border-strong'], theme.surface)).toBeGreaterThanOrEqual(3);
      });
    });
  }
}
