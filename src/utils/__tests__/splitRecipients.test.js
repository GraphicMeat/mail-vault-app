import { describe, it, expect } from 'vitest';
import { splitRecipients } from '../emailParser';

describe('splitRecipients', () => {
  it('splits a plain comma-separated list', () => {
    expect(splitRecipients('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com']);
  });

  it('drops a trailing comma', () => {
    expect(splitRecipients('a@b.com,')).toEqual(['a@b.com']);
  });

  it('drops empty segments in the middle', () => {
    expect(splitRecipients('a@b.com, , c@d.com')).toEqual(['a@b.com', 'c@d.com']);
  });

  it('does not split inside a quoted display name', () => {
    expect(splitRecipients('"Doe, John" <j@d.com>, a@b.com')).toEqual([
      '"Doe, John" <j@d.com>',
      'a@b.com',
    ]);
  });

  it('does not split inside angle brackets', () => {
    expect(splitRecipients('John <j@d.com>, Jane <jane@d.com>')).toEqual([
      'John <j@d.com>',
      'Jane <jane@d.com>',
    ]);
  });

  it('handles an escaped quote inside a quoted name', () => {
    expect(splitRecipients('"a \\" b, c" <x@y.z>')).toEqual(['"a \\" b, c" <x@y.z>']);
  });

  it('returns [] for empty or missing input', () => {
    expect(splitRecipients('')).toEqual([]);
    expect(splitRecipients(null)).toEqual([]);
    expect(splitRecipients(undefined)).toEqual([]);
  });
});
