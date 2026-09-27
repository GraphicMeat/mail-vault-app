// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { linkifyHtml, linkifyText } from '../linkify';
import { getEmailBodyContent } from '../emailIframeTemplate';
import { plainTextBodyHtml } from '../mailto';

const links = html => {
  const box = document.createElement('div');
  box.innerHTML = html;
  return [...box.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
};

describe('linkifyHtml', () => {
  it('links a bare url and leaves the text around it', () => {
    const out = linkifyHtml('<p>see https://example.com/a?b=1 now</p>');
    expect(links(out)).toEqual([['https://example.com/a?b=1', 'https://example.com/a?b=1']]);
    expect(out).toBe('<p>see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a> now</p>');
  });

  it('links www. as https and keeps the sentence full stop outside', () => {
    const out = linkifyHtml('<p>Go to www.example.com.</p>');
    expect(links(out)).toEqual([['www.example.com', 'https://www.example.com']]);
    expect(out).toContain('</a>.</p>');
  });

  it('links a bare email address as mailto', () => {
    expect(links(linkifyHtml('<p>write bob@example.com today</p>'))).toEqual([['bob@example.com', 'mailto:bob@example.com']]);
  });

  it('trims trailing punctuation', () => {
    const out = linkifyHtml('<p>Visit https://x.com/a, or https://y.org! Also http://z.net/p?; ok: https://w.io:</p>');
    expect(links(out).map(([, href]) => href)).toEqual(['https://x.com/a', 'https://y.org', 'http://z.net/p', 'https://w.io']);
  });

  it('drops an unbalanced closing bracket but keeps a balanced one', () => {
    expect(links(linkifyHtml('<p>(see https://x.com/a)</p>'))).toEqual([['https://x.com/a', 'https://x.com/a']]);
    expect(links(linkifyHtml('<p>https://en.wikipedia.org/wiki/Foo_(bar)</p>')))
      .toEqual([['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)']]);
    expect(links(linkifyHtml('<p>[https://x.com/b]</p>'))).toEqual([['https://x.com/b', 'https://x.com/b']]);
  });

  it('leaves text inside a, code, pre, style, script and textarea alone', () => {
    const html = '<a href="https://a.com">https://b.com</a><code>https://c.com</code><pre>https://d.com</pre>'
      + '<style>.x{background:url(https://e.com/i.png)}</style><script>var u="https://f.com"</script>'
      + '<textarea>https://g.com</textarea>';
    expect(linkifyHtml(html)).toBe(html);
  });

  it('gives an <a> with no href one when its text is an address', () => {
    expect(links(linkifyHtml('<p><a>https://x.com/y</a></p>'))).toEqual([['https://x.com/y', 'https://x.com/y']]);
    expect(links(linkifyHtml('<p><a> bob@example.com </a></p>'))).toEqual([[' bob@example.com ', 'mailto:bob@example.com']]);
    const anchor = '<p><a name="top">Top of page</a> and https://x.com</p>';
    expect(linkifyHtml(anchor)).toContain('<a name="top">Top of page</a>');
  });

  it('never produces a javascript: or data: link', () => {
    const html = '<p><a>javascript:alert(1)</a> javascript:alert(document.cookie) data:text/html,hi https://ok.com</p>';
    const out = linkifyHtml(html);
    expect(links(out).map(([, href]) => href)).toEqual([null, 'https://ok.com']);
    expect(out).not.toMatch(/href="(?:javascript|data):/i);
  });

  it('never turns escaped text into markup', () => {
    const out = linkifyHtml('<p>&lt;img src=x onerror=alert(1)&gt; https://x.com/"onmouseover="alert(1)</p>');
    const box = document.createElement('div');
    box.innerHTML = out;
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('a').getAttributeNames()).toEqual(['href']);
    expect(box.textContent).toBe('<img src=x onerror=alert(1)> https://x.com/"onmouseover="alert(1)');
  });

  it('returns the same string when there is nothing to link, and keeps a leading <style>', () => {
    const plain = '<p>Nothing here, <b>really</b>.</p><img src="https://cdn.example.com/p.png">';
    expect(linkifyHtml(plain)).toBe(plain);
    expect(linkifyHtml('<style>p{color:red}</style><p>https://x.com</p>')).toContain('<style>p{color:red}</style>');
  });
});

describe('linkifyText', () => {
  it('covers the whole input in order', () => {
    const text = 'a https://x.com/a. b c@d.org (www.e.com)';
    const runs = linkifyText(text);
    expect(runs.map(run => run.text).join('')).toBe(text);
    expect(runs.filter(run => run.href).map(run => run.href)).toEqual(['https://x.com/a', 'mailto:c@d.org', 'https://www.e.com']);
  });

  it('keeps an address inside a url part of the url', () => {
    expect(linkifyText('https://x.com/?u=a@b.com').map(run => run.href)).toEqual(['https://x.com/?u=a@b.com']);
  });
});

describe('every reader body gets links', () => {
  it('through getEmailBodyContent, for a whole document', () => {
    const out = getEmailBodyContent('<html><body><p>docs at https://example.com/docs</p></body></html>');
    expect(links(out)).toEqual([['https://example.com/docs', 'https://example.com/docs']]);
  });

  it('for a text/plain body rendered in a frame', () => {
    const out = getEmailBodyContent(plainTextBodyHtml('Hi,\nsee https://example.com/x and write a@b.com.'));
    expect(links(out)).toEqual([['https://example.com/x', 'https://example.com/x'], ['a@b.com', 'mailto:a@b.com']]);
  });
});
