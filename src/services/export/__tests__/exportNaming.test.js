import { describe, it, expect } from 'vitest';
import { safeSegment, singleName, threadName, threadMemberName, pageName,
  attachmentFileName, sidecarName, dedupeNames } from '../exportNaming';

const msg = (iso, from, subject) => ({ date: new Date(iso), from, subject });
const ANA = 'Ana Brandt <ana@sizzlemedia.co>';

describe('safeSegment', () => {
  it('replaces path separators and reserved characters', () => {
    expect(safeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('collapses whitespace and trims', () => {
    expect(safeSegment('  too   many   spaces  ')).toBe('too many spaces');
  });

  it('truncates to the limit without a trailing space', () => {
    expect(safeSegment('x'.repeat(300))).toHaveLength(120);
    expect(safeSegment('word '.repeat(60)).endsWith(' ')).toBe(false);
  });

  it('never returns empty', () => {
    expect(safeSegment('   ')).toBe('Untitled');
    expect(safeSegment('///')).toBe('Untitled');
  });

  it('keeps unicode', () => {
    expect(safeSegment('Duenya Uenicode')).toBe('Duenya Uenicode');
  });
});

describe('singleName', () => {
  it('is date, time, sender, subject', () => {
    expect(singleName(msg('2026-08-28T09:14:00', ANA, 'Brisket Sans licence'), 'png'))
      .toBe('2026-08-28 0914 - Ana Brandt - Brisket Sans licence.png');
  });

  it('falls back to the address when there is no display name', () => {
    expect(singleName(msg('2026-08-28T09:14:00', 'ana@sizzlemedia.co', 'Hi'), 'png'))
      .toBe('2026-08-28 0914 - ana@sizzlemedia.co - Hi.png');
  });

  it('survives an empty subject', () => {
    expect(singleName(msg('2026-08-28T09:14:00', ANA, ''), 'png'))
      .toBe('2026-08-28 0914 - Ana Brandt - Untitled.png');
  });
});

describe('threadName', () => {
  it('is the date range and the thread subject', () => {
    expect(threadName([
      msg('2026-08-12T09:14:00', ANA, 'Brisket Sans licence'),
      msg('2026-08-28T17:02:00', 'Theo Lomas <theo@skewer.systems>', 'Re: Brisket Sans licence'),
    ], 'html')).toBe('2026-08-12 to 2026-08-28 - Brisket Sans licence.html');
  });

  it('collapses a same-day thread to one date', () => {
    expect(threadName([
      msg('2026-08-12T09:14:00', ANA, 'Brisket Sans licence'),
      msg('2026-08-12T17:02:00', 'Theo Lomas <theo@skewer.systems>', 'Re: Brisket Sans licence'),
    ], 'png')).toBe('2026-08-12 - Brisket Sans licence.png');
  });

  it('takes the subject from the oldest message, stripped of Re:', () => {
    expect(threadName([
      msg('2026-08-28T17:02:00', 'Theo Lomas <theo@skewer.systems>', 'Re: Brisket Sans licence'),
      msg('2026-08-12T09:14:00', ANA, 'Brisket Sans licence'),
    ], 'png')).toBe('2026-08-12 to 2026-08-28 - Brisket Sans licence.png');
  });
});

describe('threadMemberName', () => {
  it('is a zero-padded ordinal, date, time and sender', () => {
    expect(threadMemberName(msg('2026-08-12T09:14:00', ANA, 'x'), 0, 'png'))
      .toBe('01 - 2026-08-12 0914 - Ana Brandt.png');
  });

  it('pads past nine', () => {
    expect(threadMemberName(msg('2026-08-12T09:14:00', ANA, 'x'), 11, 'png'))
      .toBe('12 - 2026-08-12 0914 - Ana Brandt.png');
  });
});

describe('pageName', () => {
  it('appends the page suffix before the extension', () => {
    expect(pageName('2026-08-12 - Brisket.png', 1, 3)).toBe('2026-08-12 - Brisket (1 of 3).png');
  });

  it('leaves a single page unsuffixed', () => {
    expect(pageName('2026-08-12 - Brisket.png', 1, 1)).toBe('2026-08-12 - Brisket.png');
  });
});

// Every fixture above hands `from` a "Name <addr>" STRING. The app never does:
// `email.from` is a {name, address} object and `to`/`cc` are arrays of them, so
// the string-only reader put "[object Object]" in every exported filename.
describe('addresses as the app actually stores them', () => {
  const OBJ = { name: 'Ana Brandt', address: 'ana@sizzlemedia.co' };

  it('names a single message after the sender, not [object Object]', () => {
    const name = singleName(msg('2024-05-01T10:30:00Z', OBJ, 'Hello'), 'png');
    expect(name).toContain('Ana Brandt');
    expect(name).not.toContain('[object Object]');
  });

  it('names a thread member after the sender', () => {
    const name = threadMemberName(msg('2024-05-01T10:30:00Z', OBJ, 'Hello'), 0, 'png');
    expect(name).toMatch(/^01 - /);
    expect(name).toContain('Ana Brandt');
    expect(name).not.toContain('[object Object]');
  });

  it('falls back to the address when there is no display name', () => {
    const name = threadMemberName(
      msg('2024-05-01T10:30:00Z', { address: 'ana@sizzlemedia.co' }, 'Hello'), 0, 'png');
    expect(name).toContain('ana@sizzlemedia.co');
  });

  it('still reads the string form the samples and fixtures use', () => {
    expect(singleName(msg('2024-05-01T10:30:00Z', ANA, 'Hello'), 'png')).toContain('Ana Brandt');
  });
});

// An attachment saved beside the export keeps the name it had in the mail —
// minus whatever no filesystem accepts. The extension is the half that matters:
// a stripped ".pdf" is a file nothing will open.
describe('attachmentFileName', () => {
  it('keeps the extension while stripping reserved characters', () => {
    expect(attachmentFileName({ filename: 'in/voice:2026.pdf', contentType: 'application/pdf' }, 0))
      .toBe('in voice 2026.pdf');
  });

  it('names an unnamed attachment after its position and its subtype', () => {
    expect(attachmentFileName({ contentType: 'application/pdf' }, 2)).toBe('attachment-3.pdf');
  });

  it('falls back to .bin when the subtype is not a plain word', () => {
    expect(attachmentFileName({ contentType: 'application/vnd.ms-excel' }, 0)).toBe('attachment-1.bin');
    expect(attachmentFileName({}, 0)).toBe('attachment-1.bin');
  });
});

describe('sidecarName', () => {
  it('reads as the export plus what came with it', () => {
    expect(sidecarName('2026-08-12 0914 - Ana Brandt - Invoice', 'invoice.pdf'))
      .toBe('2026-08-12 0914 - Ana Brandt - Invoice - invoice.pdf');
  });
});

// Two attachments called invoice.pdf are one file on disk, and the second
// silently overwrites the first — on macOS even when the cases differ.
describe('dedupeNames', () => {
  it('numbers a repeat before the extension', () => {
    expect(dedupeNames(['invoice.pdf', 'invoice.pdf', 'invoice.pdf']))
      .toEqual(['invoice.pdf', 'invoice (2).pdf', 'invoice (3).pdf']);
  });

  it('collides case-insensitively', () => {
    expect(dedupeNames(['Invoice.PDF', 'invoice.pdf'])).toEqual(['Invoice.PDF', 'invoice (2).pdf']);
  });

  it('appends at the end when there is no extension', () => {
    expect(dedupeNames(['notes', 'notes'])).toEqual(['notes', 'notes (2)']);
  });

  it('leaves distinct names alone', () => {
    expect(dedupeNames(['a.pdf', 'b.pdf'])).toEqual(['a.pdf', 'b.pdf']);
  });
});
