import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// With many chips the typing input must wrap to its own line, not shrink to a
// sliver at the end of the last one. RecipientField gives it min-width 8rem;
// a `.compose-addresses input { min-width: 0 }` rule (more specific than the
// utility class) used to zero that out.
const css = readFileSync('src/styles/index.css', 'utf8');

describe('compose address inputs', () => {
  it('never reset the recipient draft input to min-width 0', () => {
    const rules = [...css.matchAll(/([^{}]*\.compose-addresses[^{}]*)\{([^}]*)\}/g)];
    const resets = rules
      .filter(([, , body]) => /min-width:\s*0/.test(body))
      .map(([, selector]) => selector.trim())
      .filter(selector => /(^|,\s*)\.compose-addresses input(?![\w-])/.test(selector));
    expect(resets.filter(selector => !selector.includes(':not([data-recipient-input])'))).toEqual([]);
  });
});
