import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deltaE, hue, tokens } from './colorMath';

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const charts = readFileSync(new URL('../../styles/insights-charts.css', import.meta.url), 'utf8');

// The Four Roles Rule: the live-thing accent must never read as a custody
// colour. Floors are the thinnest margin the shipped palettes already keep
// (indigo light, 5.8 on tints), so a new palette cannot crowd vault or server.
const FLOOR = 5.5;

for (const mode of ['dark', 'light']) {
  for (const palette of ['indigo', 'graphite', 'teal']) {
    describe(`${mode} ${palette}`, () => {
      const base = tokens(css, `[data-theme="${mode}"] {`);
      const own = palette === 'indigo' ? {} : tokens(css, `[data-theme="${mode}"][data-palette="${palette}"] {`);
      const t = { ...base, ...own };
      it('keeps accent ink and tint clear of vault and server', () => {
        for (const token of ['accent', 'accent-text']) {
          for (const custody of ['local', 'server']) {
            expect(deltaE(t[token], t[custody]), `${token} vs ${custody}`).toBeGreaterThanOrEqual(FLOOR);
          }
        }
        for (const [custody, tint] of [['local', 'local-tint'], ['server', 'server-tint']]) {
          expect(deltaE(t['accent-tint'], t[tint]), `accent-tint vs ${custody}-tint`).toBeGreaterThanOrEqual(FLOOR);
        }
      });
    });
  }
}

describe('teal palette', () => {
  it('is teal, not green or blue, so it sits between the two custody hues', () => {
    for (const mode of ['dark', 'light']) {
      const t = tokens(css, `[data-theme="${mode}"][data-palette="teal"] {`);
      for (const token of ['accent', 'accent-text', 'accent-fill']) {
        expect(hue(t[token]), `${mode} ${token}`).toBeGreaterThanOrEqual(180);
        expect(hue(t[token]), `${mode} ${token}`).toBeLessThanOrEqual(200);
      }
    }
  });

  it('recolors the Insights ramp so charts do not stay purple', () => {
    for (const mode of ['dark', 'light']) {
      const rule = tokens(charts, `[data-theme="${mode}"][data-palette="teal"] .insights-chart {`, 'insights');
      for (const level of ['level-1', 'level-2', 'level-3', 'level-4']) {
        expect(hue(rule[level]), `${mode} ${level}`).toBeGreaterThanOrEqual(175);
        expect(hue(rule[level]), `${mode} ${level}`).toBeLessThanOrEqual(205);
      }
      expect(rule.zero).toBeTruthy();
    }
  });
});
