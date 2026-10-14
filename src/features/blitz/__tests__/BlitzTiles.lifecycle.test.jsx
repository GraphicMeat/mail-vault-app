// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
vi.mock('../service', () => ({
  openRender: vi.fn(), hitRender: vi.fn(), closeRender: vi.fn(),
  tileUrl: (d, r, i) => `mvrender://localhost/${d}%2F${r}%2F${i}`,
  onRenderUpdated: vi.fn(async () => () => {}),
  textRunsRender: vi.fn(async () => ({ runs: [] })),
  serializeRender: vi.fn(async () => ({ html: '', text: '' })),
  foldRender: vi.fn(async () => ({ rev: 1, meta: {} })),
}));
import { openRender, hitRender, textRunsRender, serializeRender } from '../service';
import BlitzTiles from '../BlitzTiles';

const meta = (over = {}) => ({ cssWidth: 600, cssHeight: 100, tileCssHeight: 512, tileCount: 1, links: [], plainText: '', folds: [], ...over });
const tiles = (p = {}) => <BlitzTiles html="<p>x" theme={{ dark: false }} onLink={vi.fn()} onFailure={vi.fn()} sizing="content" {...p} />;

// What the copy controller listens to (BlitzTiles), and the menu's window listeners.
const DOC = ['selectionchange', 'pointerdown', 'pointerup', 'pointercancel', 'keyup', 'copy'];
const WIN = ['blur', 'resize'];

/** Counts the live listeners (net of removals) added to document and window while it is installed. */
function trackListeners() {
  const live = new Set();
  const ids = new WeakMap();
  let n = 0;
  const id = (fn) => { if (!ids.has(fn)) ids.set(fn, ++n); return ids.get(fn); };
  const capture = (o) => (typeof o === 'object' && o ? !!o.capture : !!o);
  const spies = [];
  for (const [name, target] of [['document', document], ['window', window]]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    spies.push(vi.spyOn(target, 'addEventListener').mockImplementation(function (type, fn, o) {
      live.add(`${name}|${type}|${capture(o)}|${id(fn)}`);
      return add.call(this, type, fn, o);
    }));
    spies.push(vi.spyOn(target, 'removeEventListener').mockImplementation(function (type, fn, o) {
      live.delete(`${name}|${type}|${capture(o)}|${id(fn)}`);
      return remove.call(this, type, fn, o);
    }));
  }
  const count = (name, type) => [...live].filter(k => k.startsWith(`${name}|${type}|`)).length;
  const snapshot = () => Object.fromEntries([...DOC.map(t => [`document ${t}`, count('document', t)]), ...WIN.map(t => [`window ${t}`, count('window', t)])]);
  return { snapshot, restore: () => spies.forEach(s => s.mockRestore()) };
}

const select = (span, from, to) => {
  const r = document.createRange();
  r.setStart(span.firstChild, from);
  r.setEnd(span.firstChild, to);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
};

afterEach(cleanup);

// React puts its own one-time selectionchange listener on the document at the first root.
beforeAll(() => { render(<div />).unmount(); });

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ contentRect: { width: 600 }, target: el }]); } disconnect() {} };
  globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ isIntersecting: true, target: el }]); } unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta() });
  textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
  serializeRender.mockResolvedValue({ html: '<p>hel</p>', text: 'hel' });
});

describe('BlitzTiles listeners and timers', () => {
  it('a StrictMode double mount leaves exactly the listeners one mount leaves, and unmount removes them all', async () => {
    const t = trackListeners();
    try {
      const base = t.snapshot();
      const one = render(tiles());
      await screen.findByText('hello');
      const single = t.snapshot();
      for (const type of DOC) expect(single[`document ${type}`], type).toBe(base[`document ${type}`] + 1);
      expect(single['window blur']).toBe(base['window blur'] + 1);
      one.unmount();
      expect(t.snapshot()).toEqual(base);

      const strict = render(<React.StrictMode>{tiles()}</React.StrictMode>);
      await screen.findByText('hello');
      expect(t.snapshot()).toEqual(single);
      strict.unmount();
      expect(t.snapshot()).toEqual(base);
    } finally { t.restore(); }
  });

  it('a new rev or document swaps the copy listeners, never stacks them', async () => {
    const t = trackListeners();
    try {
      const base = t.snapshot();
      const { rerender, unmount } = render(tiles({ html: '<p>A' }));
      await screen.findByText('hello');
      const single = t.snapshot();
      openRender.mockResolvedValue({ docId: 6, rev: 1, meta: meta() });
      rerender(tiles({ html: '<p>B' }));
      await waitFor(() => expect(openRender).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(t.snapshot()).toEqual(single);
      unmount();
      expect(t.snapshot()).toEqual(base);
    } finally { t.restore(); }
  });

  it('the open context menu\'s window listeners (blur, resize) go with the body', async () => {
    hitRender.mockResolvedValue({ link: null, fold: null });
    const t = trackListeners();
    try {
      const { unmount } = render(tiles());
      await screen.findByText('hello');
      const copyOnly = t.snapshot();
      fireEvent.contextMenu((await screen.findAllByTestId('blitz-tile'))[0], { clientX: 40, clientY: 50 });
      await screen.findByTestId('blitz-context-menu');
      const open = t.snapshot();
      expect(open['window resize']).toBe(copyOnly['window resize'] + 1);
      expect(open['window blur']).toBe(copyOnly['window blur'] + 1);
      unmount();
      const after = t.snapshot();
      expect(after['window resize']).toBe(0);
      expect(after['window blur']).toBe(0);
      for (const type of DOC) expect(after[`document ${type}`], type).toBe(0);
    } finally { t.restore(); }
  });

  it('no serialize runs after unmount: the debounce timer dies with the controller', async () => {
    const { unmount } = render(tiles());
    const span = await screen.findByText('hello');
    select(span, 0, 3);
    document.dispatchEvent(new Event('selectionchange')); // arms the 120 ms pause
    unmount();
    await new Promise(r => setTimeout(r, 250));
    expect(serializeRender).not.toHaveBeenCalled();
  });

  it('a pointer up outside the layer, after a drag that began inside it, still serializes the selection', async () => {
    render(tiles());
    const span = await screen.findByText('hello');
    fireEvent.pointerDown(span);
    select(span, 0, 3);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r => setTimeout(r, 200));
    expect(serializeRender, 'still mid-drag').not.toHaveBeenCalled();
    fireEvent.pointerUp(document.body); // released over the app chrome
    await waitFor(() => expect(serializeRender).toHaveBeenCalledWith(5, { node: 1, offset: 0 }, { node: 1, offset: 3 }));
  });

  it('a pointer cancel, or the window losing focus mid-drag, ends it the same way', async () => {
    render(tiles());
    const span = await screen.findByText('hello');
    fireEvent.pointerDown(span);
    select(span, 0, 3);
    document.dispatchEvent(new Event('selectionchange'));
    fireEvent.pointerCancel(document.body);
    await waitFor(() => expect(serializeRender).toHaveBeenCalledTimes(1));
    serializeRender.mockClear();
    select(span, 1, 4);
    fireEvent.pointerDown(span);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r => setTimeout(r, 200));
    expect(serializeRender).not.toHaveBeenCalled();
    fireEvent.blur(window);
    await waitFor(() => expect(serializeRender).toHaveBeenCalledWith(5, { node: 1, offset: 1 }, { node: 1, offset: 4 }));
  });

  it('a press that starts outside the layer does not hold the selection back from the pause', async () => {
    render(tiles());
    const span = await screen.findByText('hello');
    select(span, 0, 3);
    fireEvent.pointerDown(document.body);
    document.dispatchEvent(new Event('selectionchange'));
    await waitFor(() => expect(serializeRender).toHaveBeenCalledTimes(1));
  });
});
