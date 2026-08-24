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
});
