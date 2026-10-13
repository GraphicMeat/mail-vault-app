// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { assignParityIds, stampParityIds } from '../parityIds';

const doc = (html) => new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`, 'text/html');

describe('assignParityIds', () => {
  afterEach(() => { delete globalThis.__MV_PARITY__; });

  it('names elements by tag path with per-tag sibling indices', () => {
    const d = doc('<div><p>a</p><p>b</p><span></span></div><div></div>');
    expect(assignParityIds(d.body, false).map((x) => x.id)).toEqual([
      'div[1]', 'div[1]/p[1]', 'div[1]/p[2]', 'div[1]/span[1]', 'div[2]',
    ]);
  });

  it("skips scripts and Dark Reader's nodes so the other ids do not move", () => {
    const plain = doc('<style>a{}</style><p>x</p><p>y</p>');
    const withDr = doc('<style>a{}</style><style class="darkreader darkreader--sync"></style><p>x</p><script></script><p>y</p>');
    expect(assignParityIds(withDr.body, false).map((x) => x.id))
      .toEqual(assignParityIds(plain.body, false).map((x) => x.id));
  });

  it('is self-contained (the e2e spec evaluates its source in the webview)', () => {
    const rebuilt = new Function(`return (${assignParityIds.toString()})`)();
    const d = doc('<table><tbody><tr><td>1</td></tr></tbody></table>');
    expect(rebuilt(d.body, false).map((x) => x.id)).toEqual(['table[1]', 'table[1]/tbody[1]', 'table[1]/tbody[1]/tr[1]', 'table[1]/tbody[1]/tr[1]/td[1]']);
  });

  it('stamps only under __MV_PARITY__', () => {
    const d = doc('<p>x</p>');
    expect(stampParityIds(d)).toBe(0);
    expect(d.querySelector('[data-mv-id]')).toBeNull();
    globalThis.__MV_PARITY__ = true;
    expect(stampParityIds(d)).toBe(1);
    expect(d.querySelector('p').getAttribute('data-mv-id')).toBe('p[1]');
  });
});
