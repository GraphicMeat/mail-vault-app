// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { htmlToText, textToHtml } from '../RichTextEditor';

describe('htmlToText', () => {
  it('turns block tags into newlines instead of collapsing them', () => {
    expect(htmlToText('<p>Best regards,</p><p><strong>John</strong></p>'))
      .toBe('Best regards,\nJohn');
  });

  it('keeps link text and handles <br>', () => {
    expect(htmlToText('<p>John<br><a href="https://x.dev">x.dev</a></p>'))
      .toBe('John\nx.dev');
  });

  it('collapses runs of blank lines and trims', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  it('round-trips plain text', () => {
    expect(htmlToText(textToHtml('one\ntwo'))).toBe('one\ntwo');
  });

  it('returns empty for an empty editor', () => {
    expect(htmlToText('<p></p>')).toBe('');
  });
});
