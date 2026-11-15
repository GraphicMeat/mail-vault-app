// A settings row is `width: 100%` with side padding. Without border-box the padding is added to
// the width, so a <label> row (the pickers) runs 32px past the screen and clips its control.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');

describe('settings row width', () => {
  it('counts padding inside the row width', () => {
    expect(css).toMatch(/\.mv-setting \{[^}]*box-sizing: border-box/);
  });

  it('lets a picker shrink instead of pushing past the edge', () => {
    expect(css).toMatch(/\.mv-setting__select \{[^}]*max-width: [^;]+;[^}]*min-width: 0/);
  });
});
