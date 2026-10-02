// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { collectSocialLinks, socialLinksHtml, MAX_SOCIAL_LINKS } from '../socialLinks';
import { buildNameDictionary } from '../../../../utils/privacy/piiDetector';

const dict = buildNameDictionary({ names: ['Joanna Kowalczyk'] });
const BODY = [
  '<a href="https://fine.example/page">Read more</a>',
  '<a href="http://plain.example/x">Plain http</a>',
  '<a href="https://evil.example/login?u=abc">https://bank.example</a>',
  '<a href="https://track.example/r?url=https%3A%2F%2Felsewhere.example%2Fx">Offer</a>',
  '<a href="javascript:steal()">Click</a>',
  '<a href="mailto:a@b.example">mail</a><a href="#top">top</a><a href="tel:+1">tel</a><a href="/relative">rel</a><a href="ftp://x.example/f">ftp</a>',
  '<a href="https://fine.example/page">Duplicate</a>',
].join('\n');

describe('collectSocialLinks', () => {
  it('lists http(s), javascript: and data: links only, once each, worst first', () => {
    const { links, more } = collectSocialLinks(BODY);
    expect(more).toBe(0);
    expect(links.map(l => l.href)).toEqual([
      'https://evil.example/login?u=abc', // red: the text shows another site
      'javascript:steal()', // red: scheme
      'https://track.example/r?url=https%3A%2F%2Felsewhere.example%2Fx', // yellow: redirects elsewhere
      'http://plain.example/x', // not secure
      'https://fine.example/page',
    ]);
    expect(links.map(l => l.level)).toEqual(['red', 'red', 'yellow', null, null]);
    expect(links.map(l => l.insecure)).toEqual([false, false, false, true, false]);
    expect(links[0].text).toBe('https://bank.example');
  });

  it('keeps the mail\'s order within a rank, and the first text of a duplicate', () => {
    const { links } = collectSocialLinks('<a href="https://b.example">B</a><a href="https://a.example">A</a><a href="https://b.example">again</a>');
    expect(links.map(l => l.text)).toEqual(['B', 'A']);
  });

  it('a data: link and an upper-case script scheme are red', () => {
    const { links } = collectSocialLinks('<a href="data:text/html;base64,AAAA">d</a><a href="JavaScript:x()">j</a>');
    expect(links.map(l => l.level)).toEqual(['red', 'red']);
  });

  it('caps at ten, worst kept, and counts the rest', () => {
    const many = Array.from({ length: 14 }, (_, i) => `<a href="https://site${i}.example/">s${i}</a>`).join('') + '<a href="javascript:z()">z</a>';
    const { links, more } = collectSocialLinks(many);
    expect(links).toHaveLength(MAX_SOCIAL_LINKS);
    expect(more).toBe(5);
    expect(links[0].href).toBe('javascript:z()');
  });

  it('redacted: a web link is its scheme and host only, a script link its scheme only, the text masked', () => {
    const { links } = collectSocialLinks(
      '<a href="https://u:p@news.example:8443/unsub/joanna.k%40example.org?t=SECRET#frag">Hi Joanna Kowalczyk</a>'
      + '<a href="javascript:alert(\'joanna.k@example.org\')">go</a>'
      + '<a href="http://shop.example/o/123">https://shop.example/o/123?e=joanna.k@example.org</a>',
      { dict, redact: true });
    expect(links.map(l => l.href)).toEqual(['javascript:', 'http://shop.example', 'https://news.example']);
    expect(links[2].text).toBe('Hi xxxxxx xxxxxxxxx');
    // Link text that is itself a URL is reduced the same way: its path carries the recipient.
    expect(links[1].text).toBe('https://shop.example');
    const all = JSON.stringify(links);
    for (const leak of ['SECRET', 'joanna', 'frag', 'unsub', '8443', 'u:p', 'alert', '/o/123', 'Joanna']) expect(all).not.toContain(leak);
  });

  it('keeps the classification of the real link when redacting', () => {
    const { links } = collectSocialLinks('<a href="https://evil.example/login">https://bank.example</a>', { dict, redact: true });
    expect(links[0]).toMatchObject({ level: 'red', href: 'https://evil.example', insecure: false });
  });

  it('nothing to list for an empty body or one with no web link', () => {
    expect(collectSocialLinks('')).toEqual({ links: [], more: 0 });
    expect(collectSocialLinks('<p>hi</p><a href="mailto:x@y.z">m</a>')).toEqual({ links: [], more: 0 });
  });
});

describe('socialLinksHtml', () => {
  it('a box with a badge per verdict, the text, then the destination in monospace', () => {
    const html = socialLinksHtml(collectSocialLinks(BODY));
    expect(html).toContain('>Links<');
    expect(html).toContain('>Dangerous<');
    expect(html).toContain('>Suspicious<');
    expect(html).toContain('>Not secure (http)<');
    expect(html).toMatch(/<div class="mv-link-text">https:\/\/bank\.example<\/div><div class="mv-mono">https:\/\/evil\.example\/login\?u=abc<\/div>/);
    expect(html).not.toMatch(/\+\d+ more/);
  });

  it('says how many more there are', () => {
    const many = Array.from({ length: 12 }, (_, i) => `<a href="https://s${i}.example/">s</a>`).join('');
    expect(socialLinksHtml(collectSocialLinks(many))).toContain('+2 more');
  });

  it('nothing at all when there is no link', () => {
    expect(socialLinksHtml({ links: [], more: 0 })).toBe('');
    expect(socialLinksHtml()).toBe('');
  });

  it('escapes the text and the address', () => {
    const html = socialLinksHtml({ links: [{ text: '<script>x()</script>', href: 'https://a.example/"><img src=x>', level: null, insecure: false }], more: 0 });
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('shortens a very long address', () => {
    const html = socialLinksHtml({ links: [{ text: '', href: `https://a.example/${'x'.repeat(300)}`, level: null, insecure: false }], more: 0 });
    expect(html).toContain('…');
    expect(html.length).toBeLessThan(900);
  });
});
