import { describe, it, expect } from 'vitest';
import {
  parseRecipientText, parseRecipientPaste, splitRecipientField, addRecipients, removeRecipient,
  removeRecipients, removeRecipientToken, replaceRecipient, isValidRecipient, recipientAddress,
  recipientDisplay, invalidRecipients, withoutRecipients,
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

describe('mailto links with several headers', () => {
  it('keeps a comma inside the ?query from splitting the address list', () => {
    expect(parseRecipientText('mailto:a@b.de?cc=c@d.de,e@f.de&subject=x')).toEqual(['a@b.de']);
  });

  it('routes ?cc= and ?bcc= to their own lists', () => {
    expect(parseRecipientPaste('mailto:a@b.de?cc=c@d.de&bcc=e@f.de,g@h.de&subject=x')).toEqual({
      to: ['a@b.de'], cc: ['c@d.de'], bcc: ['e@f.de', 'g@h.de'],
    });
  });

  it('adds a ?to= address to To and decodes escapes', () => {
    expect(parseRecipientPaste('mailto:a@b.de?to=c%40d.de&cc=e%40f.de')).toEqual({
      to: ['a@b.de', 'c@d.de'], cc: ['e@f.de'], bcc: [],
    });
  });

  it('puts a plain list in To', () => {
    expect(parseRecipientPaste('a@b.de, c@d.de')).toEqual({ to: ['a@b.de', 'c@d.de'], cc: [], bcc: [] });
    expect(parseRecipientPaste('')).toEqual({ to: [], cc: [], bcc: [] });
  });
});

describe('recipientDisplay', () => {
  it('shows the name, keeps the address for the tooltip', () => {
    expect(recipientDisplay('Ann <A@b.de>')).toEqual({ label: 'Ann', address: 'A@b.de' });
    expect(recipientDisplay('"Doe, John" <j@d.com>')).toEqual({ label: 'Doe, John', address: 'j@d.com' });
    expect(recipientDisplay('"Say \\"hi\\"" <j@d.com>').label).toBe('Say "hi"');
  });

  it('shows a bare address or non-address as it is', () => {
    expect(recipientDisplay('a@b.de')).toEqual({ label: 'a@b.de', address: 'a@b.de' });
    expect(recipientDisplay('<a@b.de>')).toEqual({ label: 'a@b.de', address: 'a@b.de' });
    expect(recipientDisplay('John Doe')).toEqual({ label: 'John Doe', address: '' });
  });
});

describe('replaceRecipient', () => {
  it('swaps one chip for what was typed', () => {
    expect(replaceRecipient('a@b.de, c@d.de, ', 0, 'x@y.de')).toBe('x@y.de, c@d.de, ');
  });

  it('cleans and splits the edit; an empty edit removes the chip', () => {
    expect(replaceRecipient('a@b.de, c@d.de, ', 1, 'mailto:x@y.de; z@w.de')).toBe('a@b.de, x@y.de, z@w.de, ');
    expect(replaceRecipient('a@b.de, c@d.de, ', 0, '  ')).toBe('c@d.de, ');
  });

  it('skips an edit that repeats another chip', () => {
    expect(replaceRecipient('a@b.de, c@d.de, ', 0, 'C@D.de')).toBe('c@d.de, ');
  });

  it('keeps the draft when asked', () => {
    expect(replaceRecipient('a@b.de, c@d.de, dra', 0, 'x@y.de', { keepDraft: true })).toBe('x@y.de, c@d.de, dra');
  });
});

describe('removeRecipients / removeRecipientToken', () => {
  it('removes several chips by index', () => {
    expect(removeRecipients('a@b.de, c@d.de, e@f.de, ', [0, 2])).toBe('c@d.de, ');
  });

  it('removes a chip by the address it holds, any case or name', () => {
    expect(removeRecipientToken('Ann <a@b.de>, c@d.de, ', 'A@B.de')).toBe('c@d.de, ');
    expect(removeRecipientToken('a@b.de, c@d.de, dra', 'a@b.de')).toBe('c@d.de, dra');
  });

  it('removes a prefilled value that has no trailing comma', () => {
    expect(removeRecipientToken('a@b.de', 'a@b.de')).toBe('');
  });

  it('leaves the value alone when the address is not there', () => {
    expect(removeRecipientToken('a@b.de, ', 'x@y.de')).toBe('a@b.de, ');
  });
});

describe('invalidRecipients', () => {
  it('lists the entries that are not addresses', () => {
    expect(invalidRecipients('a@b.de, John Doe, x@y')).toEqual(['John Doe', 'x@y']);
    expect(invalidRecipients('')).toEqual([]);
    expect(invalidRecipients('"Doe, John" <j@d.com>, ')).toEqual([]);
  });
});

describe('withoutRecipients', () => {
  it('drops contacts whose address is already a chip', () => {
    const contacts = [{ address: 'A@b.de' }, { address: 'c@d.de' }];
    expect(withoutRecipients(contacts, ['Ann <a@b.de>'])).toEqual([{ address: 'c@d.de' }]);
    expect(withoutRecipients(contacts, [])).toEqual(contacts);
  });
});
