// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCopyController } from '../clipboard';

function setup(serialize) {
  document.body.innerHTML = `<div class="mv-blitz-text"><div data-tile="0"><div class="mv-blitz-root"><span data-node="1" data-start="0">hello world</span></div></div><div data-tile="1"></div><div data-tile="2"><div class="mv-blitz-root"><span data-node="7" data-start="0">far away</span></div></div></div>`;
  const el = document.querySelector('.mv-blitz-text');
  const ctl = createCopyController({ layerEl: () => el, serialize, debounceMs: 120 });
  return { el, ctl };
}
function selectAcross(el) {
  const [a, b] = el.querySelectorAll('span');
  const r = document.createRange(); r.setStart(a.firstChild, 6); r.setEnd(b.firstChild, 3);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
}
function copyEvent() {
  const data = {};
  const e = { clipboardData: { setData: (t, v) => { data[t] = v; } }, preventDefault: vi.fn() };
  return { e, data };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete globalThis.ClipboardItem; delete navigator.clipboard; });

describe('createCopyController', () => {
  it('copy uses endpoints, not loaded spans: the settled serialize result goes out synchronously', async () => {
    const serialize = vi.fn().mockResolvedValue({ html: '<p>world</p><p>tile 1</p><p>far</p>', text: 'world\ntile 1\nfar' });
    const { el, ctl } = setup(serialize);
    selectAcross(el);
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(serialize).toHaveBeenCalledWith({ node: 1, offset: 6 }, { node: 7, offset: 3 });
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(data['text/plain']).toBe('world\ntile 1\nfar');
    expect(data['text/html']).toBe('<p>world</p><p>tile 1</p><p>far</p>');
  });

  it('Cmd+C inside the debounce: plain text now, rich text through a promise ClipboardItem', async () => {
    let resolve;
    const serialize = vi.fn(() => new Promise(r => { resolve = r; }));
    const write = vi.fn().mockResolvedValue();
    globalThis.ClipboardItem = class { constructor(items) { this.items = items; } };
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    const { el, ctl } = setup(serialize);
    selectAcross(el);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('world\nfar');
    expect(data['text/html']).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0];
    resolve({ html: '<b>x</b>', text: 'x' });
    const blob = await item.items['text/html'];
    expect(await blob.text()).toBe('<b>x</b>');
  });

  it('no promise ClipboardItem support: the synchronous plain text stands, nothing throws', async () => {
    const serialize = vi.fn(() => new Promise(() => {}));
    Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn().mockRejectedValue(new Error('NotAllowed')) }, configurable: true });
    globalThis.ClipboardItem = class { constructor() { throw new TypeError('promises not supported'); } };
    const { el, ctl } = setup(serialize);
    selectAcross(el);
    const { e, data } = copyEvent();
    expect(() => ctl.onCopy(e)).not.toThrow();
    expect(data['text/plain']).toBe('world\nfar');
  });

  it('a selection outside the layer is left to the webview', () => {
    const { ctl } = setup(vi.fn());
    window.getSelection().removeAllRanges();
    const { e } = copyEvent();
    ctl.onCopy(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('a stale cached result (selection changed since) is never used', async () => {
    const serialize = vi.fn().mockResolvedValueOnce({ html: 'OLD', text: 'OLD' });
    const { el, ctl } = setup(serialize);
    selectAcross(el);
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(120);
    const span = el.querySelector('span');
    const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 5);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('hello');
  });
});
