import { describe, it, expect } from 'vitest';
import { splitQuotedContent } from '../quoteFolding';

describe('splitQuotedContent', () => {
  it('splits a Fastmail header that carries no dashes', () => {
    const { newContent, quotedContent } = splitQuotedContent(
      'Thanks for everything.\n\nBen\n\n*Original Message*\nFrom: Ben <ben@fea.st>\nGood morning!'
    );

    expect(newContent).toBe('Thanks for everything.\n\nBen');
    expect(quotedContent).toContain('Good morning!');
  });

  it('still splits the dashed Outlook header', () => {
    const { newContent, quotedContent } = splitQuotedContent(
      'Answer above.\n\n-------- Original Message --------\nFrom: Ann\nQuoted line'
    );

    expect(newContent).toBe('Answer above.');
    expect(quotedContent).toContain('Quoted line');
  });

  it('splits on an attribution line', () => {
    const { newContent, quotedContent } = splitQuotedContent(
      'Answer above.\n\nOn Fri, Aug 21, 2026, at 8:54 PM, prime@graphicmeat.com wrote:\n> quoted'
    );

    expect(newContent).toBe('Answer above.');
    expect(quotedContent).toContain('> quoted');
  });

  it('leaves a sentence that mentions an original message alone', () => {
    const text = 'I re-read your original message twice.\nThanks!';
    expect(splitQuotedContent(text)).toEqual({ newContent: text, quotedContent: '' });
  });

  // Folding a reply that is all quote leaves nothing to read.
  it('keeps a reply that is all quote whole', () => {
    for (const text of [
      'On Fri, Sep 26, 2026 at 19:40, Person A <a@example.com> wrote:\n> Quoted line',
      '-------- Original Message --------\nFrom: Person A\nQuoted line',
      '\n> Quoted line\n> More quoted',
    ]) {
      expect(splitQuotedContent(text)).toEqual({ newContent: text, quotedContent: '' });
    }
  });

  it('keeps a reply whose only own text is a signature whole', () => {
    const text = '-- \nPerson B\n\nOn Fri, Sep 26, 2026 at 19:40, Person A <a@example.com> wrote:\n> Quoted line';
    expect(splitQuotedContent(text)).toEqual({ newContent: text, quotedContent: '' });
  });
});
