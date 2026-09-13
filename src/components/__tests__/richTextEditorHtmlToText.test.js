// @vitest-environment jsdom
//
// htmlToText writes the text/plain twin of a message. It has to read the way
// the HTML reads on screen: the text part used to be TipTap's getText(), which
// put a blank line after every paragraph and three for every blank line.

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

  it('keeps every blank line the editor shows', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\n\nb');
    expect(htmlToText('<p>a</p><p><br></p><p><br></p><p>b</p>')).toBe('a\n\n\nb');
  });

  it('round-trips plain text', () => {
    expect(htmlToText(textToHtml('one\ntwo'))).toBe('one\ntwo');
    expect(htmlToText(textToHtml('one\n\ntwo'))).toBe('one\n\ntwo');
  });

  it('returns empty for an empty editor', () => {
    expect(htmlToText('<p></p>')).toBe('');
    expect(htmlToText('<p><br></p>')).toBe('');
  });

  it('writes the reported message line for line', () => {
    const html = '<p>Lorem ipsum</p><p><br></p><p>dolor sit amet, consectetuer</p><p><br></p>'
      + '<p>Lorem ipsum<br>dolor sit amet,<br>2222 Donec pede ju<br>www.nodomain.cc</p>';
    expect(htmlToText(html)).toBe(
      'Lorem ipsum\n\ndolor sit amet, consectetuer\n\nLorem ipsum\ndolor sit amet,\n2222 Donec pede ju\nwww.nodomain.cc',
    );
  });

  it('keeps the blank line a line break at the end of a paragraph leaves', () => {
    expect(htmlToText('<p>Hey Ben,<br><br></p><p>Next</p>')).toBe('Hey Ben,\n\nNext');
  });

  it('marks list items and numbers ordered ones', () => {
    expect(htmlToText('<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>first</p></li><li><p>second</p></li></ol>'))
      .toBe('- one\n- two\n1. first\n2. second');
  });

  it('indents a nested list', () => {
    expect(htmlToText('<ul><li><p>one</p><ul><li><p>inner</p></li></ul></li></ul>')).toBe('- one\n  - inner');
  });

  it('prefixes quoted lines with "> "', () => {
    expect(htmlToText('<p>Reply</p><blockquote><p>quoted</p><p></p><p>more</p></blockquote>'))
      .toBe('Reply\n> quoted\n>\n> more');
    expect(htmlToText('<blockquote>bare quoted text</blockquote>')).toBe('> bare quoted text');
  });

  it('adds a link address after its text when the text does not already say it', () => {
    expect(htmlToText('<p>See <a href="https://mailvault.app/faq">the FAQ</a></p>'))
      .toBe('See the FAQ <https://mailvault.app/faq>');
    expect(htmlToText('<p><a href="https://www.nodomain.cc">www.nodomain.cc</a></p>')).toBe('www.nodomain.cc');
    expect(htmlToText('<p><a href="mailto:ben@example.com">ben@example.com</a></p>')).toBe('ben@example.com');
  });

  it('keeps preformatted text as it is', () => {
    expect(htmlToText('<pre><code>if (a) {\n  b();\n}</code></pre>')).toBe('if (a) {\n  b();\n}');
  });

  it('reads received HTML the way it renders: whitespace collapsed, styles and scripts left out', () => {
    expect(htmlToText(
      '<html><head><style>p{color:red}</style></head><body>\n  <div>\n    Hello\n    world\n  </div>\n'
      + '  <script>x()</script><div>Bye</div></body></html>',
    )).toBe('Hello world\nBye');
  });

  it('reads a Gmail blank line and an Outlook blank line as one blank line', () => {
    expect(htmlToText('<div dir="ltr">Hi,<div><br></div><div>text</div></div>')).toBe('Hi,\n\ntext');
    expect(htmlToText('<p class="MsoNormal">Hi,</p><p class="MsoNormal">&nbsp;</p><p class="MsoNormal">text</p>'))
      .toBe('Hi,\n\ntext');
  });
});

// Plain text is characters, never markup: a received plain-text mail is quoted
// into a reply through textToHtml.
describe('textToHtml', () => {
  it('writes angle brackets and ampersands as text', () => {
    expect(textToHtml('<img src=x onerror="alert(1)"> Fish & chips'))
      .toBe('<p>&lt;img src=x onerror="alert(1)"&gt; Fish &amp; chips</p>');
  });

  it('round-trips a quote line that names an address', () => {
    const text = 'On Monday, Ann <ann@example.com> wrote:\n> a < b && b > c';
    expect(htmlToText(textToHtml(text))).toBe(text);
  });
});
