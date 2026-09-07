/**
 * `.truncate` is overridden app-wide to `overflow: clip` (src/styles/index.css)
 * so WebKit can never scroll a truncated box sideways. `clip` does not make a
 * scroll container, so a flex item loses the automatic `min-width: 0` that
 * `overflow: hidden` used to give it for free: a long container path on
 * Settings > Backup & Restore > Backup Settings then widened the whole pane
 * instead of truncating (2026-09-07). The override has to hand that minimum
 * back explicitly, or every `flex-1 truncate` in the app grows with its text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8');

/** Every declaration on a bare `.truncate` rule in the app stylesheet. */
function truncateDecls() {
  const decls = {};
  postcss.parse(css).walkRules('.truncate', (rule) => {
    rule.walkDecls((d) => { decls[d.prop] = d.value; });
  });
  return decls;
}

describe('.truncate override', () => {
  it('keeps overflow: clip so a truncated box can never scroll', () => {
    expect(truncateDecls().overflow).toBe('clip');
  });

  it('gives a truncated flex item back the zero minimum that clip took away', () => {
    expect(truncateDecls()['min-width']).toBe('0');
  });
});
