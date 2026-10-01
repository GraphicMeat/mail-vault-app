// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildNameDictionary } from '../piiDetector';
import { redactTree, PII_CLASS } from '../redactDom';

const dict = buildNameDictionary({ names: ['John Smith'] });
const mount = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('redactTree', () => {
  it('replaces matches with filler and never keeps the original in markup', () => {
    const root = mount('<p>Hi John Smith, mail john@x.com</p><script>John Smith</script>');
    const originals = [];
    const n = redactTree(root, dict, { onText: (_s, o) => originals.push(o) });
    expect(n).toBe(2);
    expect(root.querySelector('p').textContent).not.toMatch(/John|Smith|john@x\.com/);
    expect(root.querySelector('p').innerHTML).not.toContain('John');
    expect(root.querySelector('script').textContent).toBe('John Smith'); // script text is skipped
    expect(root.querySelectorAll(`span.${PII_CLASS}`)).toHaveLength(2);
    expect(originals).toEqual(['John Smith', 'john@x.com']);
  });

  it('masks attributes and strips leaking hrefs', () => {
    const root = mount(`<a href="mailto:john@x.com" title="John Smith">x</a>
      <a href="https://t.co/c?u=john%40x.com">t</a><a href="https://ok.example/">ok</a>
      <img alt="Photo of John Smith">`);
    const attrs = [];
    redactTree(root, dict, { onAttr: (el, name, orig) => attrs.push([name, orig]) });
    const [a1, a2, a3] = root.querySelectorAll('a');
    expect(a1.hasAttribute('href')).toBe(false);
    expect(a1.getAttribute('title')).toBe('xxxx xxxxx');
    expect(a2.hasAttribute('href')).toBe(false);
    expect(a3.getAttribute('href')).toBe('https://ok.example/');
    expect(root.querySelector('img').getAttribute('alt')).toBe('Photo of xxxx xxxxx');
    expect(attrs).toContainEqual(['href', 'mailto:john@x.com']);
  });

  it('does not re-wrap text already inside a mask span', () => {
    const root = mount('<p>John Smith</p>');
    redactTree(root, dict);
    const htmlAfter = root.innerHTML;
    const attrs = [];
    expect(redactTree(root, dict, { onAttr: (el, name) => attrs.push(name) })).toBe(0);
    expect(root.innerHTML).toBe(htmlAfter);
    expect(attrs).toHaveLength(0);
  });

  it('handles malformed percent-encoded URLs without throwing', () => {
    const root = mount('<a href="https://t.co/?d=50%&u=john%40x.com">bad</a>');
    expect(() => redactTree(root, dict)).not.toThrow();
    expect(root.querySelector('a').hasAttribute('href')).toBe(false);
  });

  it('strips hrefs with leading whitespace in scheme', () => {
    const root = mount('<a href=" tel:112">call</a>');
    redactTree(root, dict);
    expect(root.querySelector('a').hasAttribute('href')).toBe(false);
  });

  it('strips tel: hrefs even with no other content', () => {
    const root = mount('<a href="tel:+37061234567">dial</a>');
    redactTree(root, dict);
    expect(root.querySelector('a').hasAttribute('href')).toBe(false);
  });

  it('skips style text in case-insensitive svg elements', () => {
    const root = mount('<svg><style>John Smith</style></svg>');
    const originals = [];
    const n = redactTree(root, dict, { onText: (_s, o) => originals.push(o) });
    expect(n).toBe(0);
    expect(root.querySelector('style').textContent).toBe('John Smith');
  });

  it('masks input value, label, and aria-description attributes', () => {
    const root = mount(`<input value="John Smith">
      <label>Name: John Smith</label>
      <div aria-description="John Smith is here">info</div>`);
    const attrs = [];
    redactTree(root, dict, { onAttr: (el, name, orig) => attrs.push([name, orig]) });
    expect(root.querySelector('input').getAttribute('value')).toBe('xxxx xxxxx');
    expect(root.querySelector('label').getAttribute('label')).toBeNull();
    expect(root.querySelector('label').textContent).not.toMatch(/John|Smith/);
    expect(root.querySelector('[aria-description]').getAttribute('aria-description')).toBe('xxxx xxxxx is here');
    expect(attrs).toContainEqual(['value', 'John Smith']);
    expect(attrs).toContainEqual(['aria-description', 'John Smith is here']);
  });
});
