import { describe, it, expect } from 'vitest';
import {
  parseRecipientText, splitRecipientField, addRecipients, removeRecipient,
  isValidRecipient, recipientAddress,
} from '../recipientTokens';

describe('parseRecipientText', () => {
  it('drops mailto: from a pasted link', () => {
    expect(parseRecipientText('mailto:impressum@amazon.de')).toEqual(['impressum@amazon.de']);
  });

  it('matches mailto: in any case and decodes percent escapes', () => {
    expect(parseRecipientText('MAILTO:a@b.de')).toEqual(['a@b.de']);
    expect(parseRecipientText('mailto:a%40b.de')).toEqual(['a@b.de']);
  });

  it('drops the ?query of a mailto link and keeps a literal plus', () => {
    expect(parseRecipientText('mailto:a+lists@b.de?subject=Hi%20there&body=x')).toEqual(['a+lists@b.de']);
  });

  it('splits a mailto link with several addresses', () => {
    expect(parseRecipientText('mailto:a@b.de,c@d.de?subject=x')).toEqual(['a@b.de', 'c@d.de']);
  });

  it('strips mailto: from each pasted token', () => {
    expect(parseRecipientText('mailto:a@b.de; mailto:c@d.de')).toEqual(['a@b.de', 'c@d.de']);
  });

  it('splits on commas, semicolons, newlines and whitespace between bare addresses', () => {
    expect(parseRecipientText('a@b.de, c@d.de')).toEqual(['a@b.de', 'c@d.de']);
    expect(parseRecipientText('a@b.de; c@d.de')).toEqual(['a@b.de', 'c@d.de']);
    expect(parseRecipientText('a@b.de\r\nc@d.de\n\ne@f.de')).toEqual(['a@b.de', 'c@d.de', 'e@f.de']);
    expect(parseRecipientText('a@b.de c@d.de\te@f.de')).toEqual(['a@b.de', 'c@d.de', 'e@f.de']);
  });

  it('keeps a display name and its comma together', () => {
    expect(parseRecipientText('"Doe, John" <j@d.com>, a@b.com')).toEqual(['"Doe, John" <j@d.com>', 'a@b.com']);
    expect(parseRecipientText('John Doe <j@d.com>')).toEqual(['John Doe <j@d.com>']);
  });

  it('splits an Outlook-style list ending in a semicolon', () => {
    expect(parseRecipientText('John Doe <j@d.com>; Jane <k@d.com>;')).toEqual(['John Doe <j@d.com>', 'Jane <k@d.com>']);
  });

  it('unwraps a bare <address>', () => {
    expect(parseRecipientText('<a@b.de>')).toEqual(['a@b.de']);
  });

  it('keeps text that is not an address as one token', () => {
    expect(parseRecipientText('John Doe')).toEqual(['John Doe']);
  });

  it('drops empties and duplicates', () => {
    expect(parseRecipientText('a@b.de, A@B.DE, ,; ')).toEqual(['a@b.de']);
    expect(parseRecipientText('mailto:')).toEqual([]);
    expect(parseRecipientText('')).toEqual([]);
    expect(parseRecipientText(null)).toEqual([]);
  });
});

describe('splitRecipientField', () => {
  it('treats everything before the last separator as committed', () => {
    expect(splitRecipientField('a@b.de, c@d.de, ')).toEqual({ chips: ['a@b.de', 'c@d.de'], draft: '' });
    expect(splitRecipientField('a@b.de, c@')).toEqual({ chips: ['a@b.de'], draft: 'c@' });
    expect(splitRecipientField('a@b.de; c')).toEqual({ chips: ['a@b.de'], draft: 'c' });
  });

  it('treats a lone token as the draft', () => {
    expect(splitRecipientField('a@b.de')).toEqual({ chips: [], draft: 'a@b.de' });
    expect(splitRecipientField('')).toEqual({ chips: [], draft: '' });
  });

  it('does not split inside a quoted name', () => {
    expect(splitRecipientField('"Doe, John" <j@d.de>')).toEqual({ chips: [], draft: '"Doe, John" <j@d.de>' });
    expect(splitRecipientField('"Doe, John" <j@d.de>, x')).toEqual({ chips: ['"Doe, John" <j@d.de>'], draft: 'x' });
  });
});

describe('addRecipients', () => {
  it('appends cleaned addresses, each followed by a comma', () => {
    expect(addRecipients('', 'mailto:x@y.de')).toBe('x@y.de, ');
    expect(addRecipients('a@b.de, ', 'c@d.de, e@f.de')).toBe('a@b.de, c@d.de, e@f.de, ');
  });

  it('treats the existing value as committed, with or without a trailing comma', () => {
    expect(addRecipients('a@b.de', 'c@d.de')).toBe('a@b.de, c@d.de, ');
  });

  it('skips an address already there, whatever its case or display name', () => {
    expect(addRecipients('a@b.de, ', 'A@b.de')).toBe('a@b.de, ');
    expect(addRecipients('Ann <a@b.de>, ', 'a@b.de')).toBe('Ann <a@b.de>, ');
  });

  it('adds nothing for empty input', () => {
    expect(addRecipients('', '')).toBe('');
    expect(addRecipients('a@b.de, ', '  ,; ')).toBe('a@b.de, ');
  });
});

describe('removeRecipient', () => {
  it('removes one chip by index', () => {
    expect(removeRecipient('a@b.de, c@d.de, ', 0)).toBe('c@d.de, ');
    expect(removeRecipient('a@b.de, c@d.de, ', 1)).toBe('a@b.de, ');
    expect(removeRecipient('a@b.de, ', 0)).toBe('');
  });

  it('keeps the draft after the chips', () => {
    expect(removeRecipient('a@b.de, c@d.de, x', 0, { keepDraft: true })).toBe('c@d.de, x');
  });
});

describe('recipientAddress / isValidRecipient', () => {
  it('reads the address out of a token', () => {
    expect(recipientAddress('Ann <A@B.de>')).toBe('a@b.de');
    expect(recipientAddress('a@b.de')).toBe('a@b.de');
    expect(recipientAddress('John Doe')).toBe('');
  });

  it('accepts an address and rejects the rest', () => {
    expect(isValidRecipient('a@b.de')).toBe(true);
    expect(isValidRecipient('Ann <a@b.de>')).toBe(true);
    expect(isValidRecipient('"Doe, John" <j@d.com>')).toBe(true);
    expect(isValidRecipient('John Doe')).toBe(false);
    expect(isValidRecipient('a@b')).toBe(false);
    expect(isValidRecipient('a b@c.de')).toBe(false);
  });
});
