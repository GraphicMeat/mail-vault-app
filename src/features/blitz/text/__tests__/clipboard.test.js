// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCopyController } from '../clipboard';

function setup(serialize, opts = {}) {
  document.body.innerHTML = `<div class="mv-blitz-text"><div data-tile="0"><div class="mv-blitz-root"><span data-node="1" data-start="0">hello world</span></div></div><div data-tile="1"></div><div data-tile="2"><div class="mv-blitz-root"><span data-node="7" data-start="0">far away</span></div></div></div>`;
  const el = document.querySelector('.mv-blitz-text');
  const ctl = createCopyController({ layerEl: () => el, serialize, debounceMs: 120, isWindows: false, ...opts });
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

  it('cachedText is the warm plain text of the current selection only, and never asks serialize', async () => {
    const serialize = vi.fn().mockResolvedValue({ html: '<p>world</p><p>far</p>', text: 'world\n\nfar' });
    const { el, ctl } = setup(serialize);
    selectAcross(el);
    expect(ctl.cachedText()).toBeNull(); // cold
    expect(serialize).not.toHaveBeenCalled();
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(ctl.cachedText()).toBe('world\n\nfar');
    const span = el.querySelector('span');
    const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 5);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    expect(ctl.cachedText()).toBeNull(); // another selection: not its text
    expect(serialize).toHaveBeenCalledTimes(1);
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

function selectHello(el) {
  const span = el.querySelector('span');
  const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 5);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('createCopyController: selection end, coalescing, bounded upgrade', () => {
  it('a drag serializes at pointer up, not on the pause mid-drag', async () => {
    const serialize = vi.fn().mockResolvedValue({ html: '<p>x</p>', text: 'x' });
    const { el, ctl } = setup(serialize);
    ctl.onPointerDown(el.querySelector('span'));
    selectAcross(el);
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(serialize).not.toHaveBeenCalled();
    ctl.onPointerUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith({ node: 1, offset: 6 }, { node: 7, offset: 3 });
  });

  it('a pointer down outside the layer does not hold selectionchange back', async () => {
    const serialize = vi.fn().mockResolvedValue({ html: 'x', text: 'x' });
    const { el, ctl } = setup(serialize);
    ctl.onPointerDown(document.body);
    selectAcross(el);
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('key up (shift-extend, select all) serializes at once', async () => {
    const serialize = vi.fn().mockResolvedValue({ html: 'x', text: 'x' });
    const { el, ctl } = setup(serialize);
    selectAcross(el);
    ctl.onKeyUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('at most one serialize in flight plus one trailing: the middle selection is dropped', async () => {
    const first = deferred();
    const serialize = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ html: 'B', text: 'B' });
    const { el, ctl } = setup(serialize);
    selectAcross(el); ctl.onKeyUp();
    const span = el.querySelector('span');
    const sel = (a, b) => { const r = document.createRange(); r.setStart(span.firstChild, a); r.setEnd(span.firstChild, b); window.getSelection().removeAllRanges(); window.getSelection().addRange(r); };
    sel(0, 2); ctl.onKeyUp();
    sel(0, 5); ctl.onKeyUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(serialize).toHaveBeenCalledTimes(1);
    first.resolve({ html: 'A', text: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(serialize).toHaveBeenCalledTimes(2);
    expect(serialize).toHaveBeenLastCalledWith({ node: 1, offset: 0 }, { node: 1, offset: 5 });
  });

  it('a reply whose selection is no longer current is never cached', async () => {
    const first = deferred();
    const serialize = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(new Promise(() => {}));
    const { el, ctl } = setup(serialize);
    selectAcross(el); ctl.onKeyUp();
    selectHello(el);
    first.resolve({ html: '<i>A</i>', text: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('hello');
    expect(data['text/html']).toBeUndefined();
  });

  it('the promise upgrade gives up after 800 ms', async () => {
    globalThis.ClipboardItem = class { constructor(items) { this.items = items; } };
    Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn().mockResolvedValue() }, configurable: true });
    const { el, ctl } = setup(vi.fn(() => new Promise(() => {})));
    selectAcross(el);
    const { e } = copyEvent();
    ctl.onCopy(e);
    const item = navigator.clipboard.write.mock.calls[0][0][0];
    const outcome = item.items['text/html'].then(() => 'ok', () => 'rejected');
    await vi.advanceTimersByTimeAsync(799);
    let settled = false; outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('rejected');
  });

  it('a later copy event rejects the blobs of an older one', async () => {
    const d = deferred();
    globalThis.ClipboardItem = class { constructor(items) { this.items = items; } };
    Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn().mockResolvedValue() }, configurable: true });
    const { el, ctl } = setup(vi.fn(() => d.promise));
    selectAcross(el);
    ctl.onCopy(copyEvent().e);
    const item = navigator.clipboard.write.mock.calls[0][0][0];
    const outcome = item.items['text/html'].then(() => 'ok', () => 'rejected');
    ctl.onCopy(copyEvent().e);
    d.resolve({ html: '<b>x</b>', text: 'x' });
    expect(await outcome).toBe('rejected');
  });
});

describe('createCopyController: nothing to write', () => {
  it('a cached empty result falls back to the layer text', async () => {
    const { el, ctl } = setup(vi.fn().mockResolvedValue({ html: '', text: '' }));
    selectAcross(el);
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(120);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(data['text/plain']).toBe('world\nfar');
    expect(data['text/html']).toBeUndefined();
  });

  it('empty serialize result and empty layer text: the event is left alone', async () => {
    const { el, ctl } = setup(vi.fn().mockResolvedValue({ html: '', text: '' }));
    const r = document.createRange(); r.setStart(el, 1); r.setEnd(el, 2);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    ctl.onSelectionChange();
    await vi.advanceTimersByTimeAsync(120);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });
});

describe('createCopyController: Windows line endings', () => {
  const quote = { html: '<p>wrote:</p><p>After</p>', text: 'wrote:\n\nAfter' };
  const warm = async (ctl, el) => { selectAcross(el); ctl.onSelectionChange(); await vi.advanceTimersByTimeAsync(120); };

  it('the plain flavour is CRLF on Windows, the html flavour and cachedText stay as they are', async () => {
    const { el, ctl } = setup(vi.fn().mockResolvedValue(quote), { isWindows: true });
    await warm(ctl, el);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('wrote:\r\n\r\nAfter'); // what the iframe's native copy puts on Windows
    expect(data['text/html']).toBe(quote.html);
    expect(ctl.cachedText()).toBe('wrote:\n\nAfter'); // a reply quote is not the OS clipboard
  });

  it('a CRLF already there is not doubled', async () => {
    const { el, ctl } = setup(vi.fn().mockResolvedValue({ html: 'x', text: 'a\r\nb\nc' }), { isWindows: true });
    await warm(ctl, el);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('a\r\nb\r\nc');
  });

  it('off Windows the plain flavour stays LF', async () => {
    const { el, ctl } = setup(vi.fn().mockResolvedValue(quote), { isWindows: false });
    await warm(ctl, el);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('wrote:\n\nAfter');
  });

  it('the cold floor and the promise item agree with it', async () => {
    let resolve;
    globalThis.ClipboardItem = class { constructor(items) { this.items = items; } };
    Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn().mockResolvedValue() }, configurable: true });
    const { el, ctl } = setup(vi.fn(() => new Promise(r => { resolve = r; })), { isWindows: true });
    selectAcross(el);
    const { e, data } = copyEvent();
    ctl.onCopy(e);
    expect(data['text/plain']).toBe('world\r\nfar');
    const item = navigator.clipboard.write.mock.calls[0][0][0];
    resolve(quote);
    expect(await (await item.items['text/plain']).text()).toBe('wrote:\r\n\r\nAfter');
    expect(await (await item.items['text/html']).text()).toBe(quote.html);
  });
});
