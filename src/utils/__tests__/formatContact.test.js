import { describe, it, expect } from 'vitest';
import { formatContact } from '../formatContact';

describe('formatContact', () => {
  it('renders name and address', () => {
    expect(formatContact({ name: 'John Doe', address: 'j@d.com' })).toBe('John Doe <j@d.com>');
  });

  it('renders a bare address without a name', () => {
    expect(formatContact({ address: 'j@d.com' })).toBe('j@d.com');
  });

  it('quotes a display name containing a comma', () => {
    expect(formatContact({ name: 'Doe, John', address: 'j@d.com' })).toBe('"Doe, John" <j@d.com>');
  });

  it('quotes a display name containing a semicolon or angle bracket', () => {
    expect(formatContact({ name: 'Sales; EU', address: 's@d.com' })).toBe('"Sales; EU" <s@d.com>');
    expect(formatContact({ name: 'x <spoof>', address: 'x@d.com' })).toBe('"x <spoof>" <x@d.com>');
  });

  it('escapes quotes and backslashes inside a quoted name', () => {
    expect(formatContact({ name: 'Jo"hn, D\\oe', address: 'j@d.com' })).toBe('"Jo\\"hn, D\\\\oe" <j@d.com>');
  });
});
