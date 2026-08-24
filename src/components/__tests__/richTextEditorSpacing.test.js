// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { inlineComposeSpacing } from '../RichTextEditor';

/** Parse the returned HTML so assertions read computed inline styles, not string shape. */
function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

describe('inlineComposeSpacing', () => {
  it('carries the editor paragraph spacing into the sent HTML', () => {
    // What the compose window showed: `.tiptap p { margin: 0 0 0.25em }`.
    // Bare <p> tags arrive under the client default `margin: 1em 0` instead,
    // which is the extra blank line between every paragraph.
    const body = parse(inlineComposeSpacing('<p>Hey Ben,<br></p><p>Hope all is well</p>'));
    const [first, second] = body.querySelectorAll('p');

    expect(first.style.marginTop).toBe('0px');
    expect(first.style.marginBottom).toBe('0.25em');
    expect(second.style.marginBottom).toBe('0.25em');
  });

  it('spaces lists the way the editor does', () => {
    const body = parse(inlineComposeSpacing('<ul><li>one</li></ul><ol><li>two</li></ol>'));

    expect(body.querySelector('ul').style.marginTop).toBe('0.5em');
    expect(body.querySelector('ol').style.marginTop).toBe('0.5em');
    expect(body.querySelector('li').style.marginTop).toBe('0.15em');
  });

  it('leaves blockquotes alone so the client default keeps them indented', () => {
    const body = parse(inlineComposeSpacing('<blockquote><p>quoted</p></blockquote>'));

    expect(body.querySelector('blockquote').getAttribute('style')).toBe(null);
  });

  it('keeps styles the message already carries', () => {
    const body = parse(inlineComposeSpacing(
      '<p style="text-align: center">centred</p><p style="margin: 2em 0">roomy</p>'
    ));
    const [centred, roomy] = body.querySelectorAll('p');

    expect(centred.style.textAlign).toBe('center');
    expect(centred.style.marginBottom).toBe('0.25em');
    expect(roomy.style.marginTop).toBe('2em');
  });

  it('does not touch anything else in the message', () => {
    const html = '<p>look</p><img src="cid:pic@mv"><a href="https://x.dev">x.dev</a>';
    const body = parse(inlineComposeSpacing(html));

    expect(body.querySelector('img').getAttribute('src')).toBe('cid:pic@mv');
    expect(body.querySelector('a').getAttribute('href')).toBe('https://x.dev');
  });

  it('is idempotent and safe on empty input', () => {
    const once = inlineComposeSpacing('<p>a</p>');
    expect(inlineComposeSpacing(once)).toBe(once);
    expect(inlineComposeSpacing('')).toBe('');
    expect(inlineComposeSpacing(undefined)).toBe(undefined);
  });
});
