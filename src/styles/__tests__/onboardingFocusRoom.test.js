import { describe, expect, it } from 'vitest';
import { readStyleSheet } from './readStyleSheet.js';

// The onboarding controls column clips its overflow, and its controls are
// full width. A focus ring (2px outline, 2px offset: 4px outside the box)
// on a select or a choice at the column's edge was cut off at the sides.
// The column needs at least that much padding inside its clip.
const css = readStyleSheet(new URL('../index.css', import.meta.url));
const rule = selector => {
  const match = css.match(new RegExp(`(?:^|[}\\s])${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
};
const px = (body, prop) => {
  const value = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  if (!value) return 0;
  return Math.min(...value.split(/\s+/).map(v => parseFloat(v)));
};

describe('onboarding controls column', () => {
  it('leaves room inside its clip for a full focus ring', () => {
    const body = rule('.onboarding-appearance-controls');
    expect(body).toMatch(/overflow:\s*hidden/);
    const ring = parseFloat(css.match(/select:focus-visible\s*\{\s*outline:\s*(\d+)px[^}]*outline-offset:\s*(\d+)px/)?.slice(1).reduce((a, b) => +a + +b, 0) ?? 4);
    expect(px(body, 'padding')).toBeGreaterThanOrEqual(ring);
  });
});

// The bar sat between Back and Skip tour with auto margins, so it moved
// sideways on the first step (no Back) and the last (no Skip tour), and by
// the two labels' widths everywhere else. Three columns, the outer two equal,
// keep it on the window's centre line whatever is beside it.
describe('onboarding header', () => {
  it('centres the progress bar in its own column', () => {
    const header = rule('.onboarding-header');
    expect(header).toMatch(/display:\s*grid/);
    expect(header).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/);
    expect(rule('.onboarding-progress')).toMatch(/grid-column:\s*2/);
  });
});
