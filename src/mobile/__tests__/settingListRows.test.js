// Network Activity and Unsubscribe list rows hold long unbroken text (a host:port, a sender's
// address). Without a wrap they run past a 402pt screen at 150% text. A failed connection is
// marked in the danger colour, and the summary rows put the value at the end.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
const rule = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';

describe('settings list rows with long text', () => {
  it('a connection row wraps its host and address anywhere', () => {
    expect(rule('.mv-net__row')).toMatch(/overflow-wrap: anywhere/);
    expect(rule('.mv-net__host')).toMatch(/overflow-wrap: anywhere/);
  });

  it('a failed connection is marked in the danger colour', () => {
    expect(rule('.mv-net__failed')).toMatch(/color: var\(--mv-danger\)/);
  });

  it('a summary row puts its value at the end', () => {
    expect(rule('.mv-net__stat')).toMatch(/justify-content: space-between/);
  });

  it('a sender row wraps its address, and its confirm buttons wrap too', () => {
    expect(rule('.mv-unsub__row')).toMatch(/overflow-wrap: anywhere/);
    expect(rule('.mv-unsub__confirm')).toMatch(/display: flex/);
    expect(rule('.mv-unsub__confirm')).toMatch(/flex-wrap: wrap/);
  });
});
