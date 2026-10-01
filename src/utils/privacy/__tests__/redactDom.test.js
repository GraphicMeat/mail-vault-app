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
    expect(redactTree(root, dict)).toBe(0);
  });
});
