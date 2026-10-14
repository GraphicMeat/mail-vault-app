// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
vi.mock('../service', () => ({
  openRender: vi.fn(), hitRender: vi.fn(), closeRender: vi.fn(),
  tileUrl: (d, r, i) => `mvrender://localhost/${d}%2F${r}%2F${i}`,
  onRenderUpdated: vi.fn(async () => () => {}),
  textRunsRender: vi.fn(async () => ({ runs: [] })),
  serializeRender: vi.fn(async () => ({ html: '', text: '' })),
  foldRender: vi.fn(async () => ({ rev: 1, meta: {} })),
}));
import { lightSelectionColor } from '../text/selectionColors';
import { openRender, hitRender, closeRender, onRenderUpdated, textRunsRender, serializeRender, foldRender } from '../service';
import BlitzTiles from '../BlitzTiles';
import { replySelection } from '../../../utils/replySelection';

let paneWidth = 600;
const meta = (over = {}) => ({ cssWidth: 600, cssHeight: 1100, tileCssHeight: 512, tileCount: 3, links: [], plainText: '', folds: [], ...over });
const tiles = (p = {}) => <BlitzTiles html="<p>x" theme={{ dark: false }} onLink={vi.fn()} onFailure={vi.fn()} sizing="content" {...p} />;

afterEach(cleanup); // vitest globals are off, so RTL does not unmount between tests

beforeEach(() => {
  vi.clearAllMocks();
  paneWidth = 600;
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ contentRect: { width: paneWidth }, target: el }]); } disconnect() {} };
  globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ isIntersecting: true, target: el }]); } unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
});

describe('BlitzTiles', () => {
  it('mounts the text layer over the tiles', async () => {
    openRender.mockResolvedValue({ docId: 9, rev: 1, meta: meta() });
    textRunsRender.mockResolvedValue({ runs: [] });
    render(tiles());
    expect(await screen.findByTestId('blitz-text-layer')).toBeTruthy();
  });

  it('opens at container width and DPR and lays out one img per tile', async () => {
    openRender.mockResolvedValue({ docId: 9, rev: 1, meta: meta() });
    render(tiles());
    await waitFor(() => expect(screen.getAllByTestId('blitz-tile')).toHaveLength(3));
    expect(openRender).toHaveBeenCalledWith({ html: '<p>x', cssWidth: 600, scale: 2, allowRemote: true, theme: { mode: 'light' } });
    const t = screen.getAllByTestId('blitz-tile');
    expect(t[0].getAttribute('src')).toBe('mvrender://localhost/9%2F1%2F0');
    expect(t[2].style.top).toBe('1024px');
    expect(t[2].style.height).toBe('76px');
  });

  it('without intersection only the first two tiles get a src', async () => {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    openRender.mockResolvedValue({ docId: 9, rev: 1, meta: meta() });
    render(tiles());
    const t = await screen.findAllByTestId('blitz-tile');
    expect(t.map(i => i.hasAttribute('src'))).toEqual([true, true, false]);
  });

  it('drops a stale open reply and closes its doc', async () => {
    let resolveFirst;
    openRender.mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
      .mockResolvedValueOnce({ docId: 2, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    const { rerender } = render(tiles({ html: '<p>A' }));
    rerender(tiles({ html: '<p>B' }));
    await waitFor(() => expect(screen.getAllByTestId('blitz-tile')).toHaveLength(1));
    await act(async () => { resolveFirst({ docId: 1, rev: 1, meta: meta() }); });
    expect(closeRender).toHaveBeenCalledWith(1);
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('2%2F1%2F0');
  });

  it('reports failure once: open error, or tile errors', async () => {
    const onFailure = vi.fn();
    openRender.mockRejectedValueOnce(new Error('render_too_complex'));
    render(tiles({ onFailure }));
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith('render_too_complex'));
    const onFailure2 = vi.fn();
    openRender.mockResolvedValueOnce({ docId: 3, rev: 1, meta: meta() });
    render(tiles({ html: '<p>y', onFailure: onFailure2 }));
    const t = await screen.findAllByTestId('blitz-tile');
    fireEvent.error(t[0]); fireEvent.error(t[1]);
    expect(onFailure2).toHaveBeenCalledTimes(1);
    expect(onFailure2).toHaveBeenCalledWith('render_tile_failed');
  });

  it('click hit-tests and hands the link to onLink', async () => {
    const onLink = vi.fn();
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    hitRender.mockResolvedValue({ link: { href: 'https://x.test/', text: 'x', alert: null, title: null }, fold: null });
    render(tiles({ onLink }));
    const t = await screen.findAllByTestId('blitz-tile');
    fireEvent.click(t[0], { clientX: 10, clientY: 10 });
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://x.test/' })));
  });

  describe('the hover URL chip', () => {
    const hover = async (props) => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      hitRender.mockResolvedValue({ link: { href: 'https://calendly.com/jane-doe?name=Jane%20Doe', text: 'book', alert: null, title: null }, fold: null });
      render(tiles(props));
      const t = await screen.findAllByTestId('blitz-tile');
      fireEvent.mouseMove(t[0], { clientX: 10, clientY: 10 });
      await waitFor(() => expect(hitRender).toHaveBeenCalled());
      await act(async () => {});
      return t[0].parentElement;
    };
    it('shows the link under the pointer', async () => {
      await hover({});
      expect(screen.getByTestId('blitz-link-chip').textContent).toContain('calendly.com/jane-doe');
    });
    it('is not drawn at all while privacy is on, whatever the link says', async () => {
      const surface = await hover({ privacy: true });
      expect(screen.queryByTestId('blitz-link-chip')).toBeNull();
      expect(document.body.textContent).not.toContain('jane-doe');
      expect(document.body.textContent).not.toContain('Jane');
      expect(surface.style.cursor).toBe('pointer'); // the click still works
    });
  });

  it('a render-updated event for this doc swaps tile URLs to the new rev', async () => {
    let push;
    onRenderUpdated.mockImplementation(async cb => { push = cb; return () => {}; });
    openRender.mockResolvedValue({ docId: 6, rev: 1, meta: meta() });
    render(tiles());
    await screen.findAllByTestId('blitz-tile');
    await act(async () => { push({ docId: 99, rev: 7, meta: meta() }); });
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('6%2F1%2F0');
    await act(async () => { push({ docId: 6, rev: 2, meta: meta() }); });
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('6%2F2%2F0');
  });

  it('an html change keeps the old tiles until the new doc is ready, then closes the old doc', async () => {
    openRender.mockResolvedValueOnce({ docId: 1, rev: 1, meta: meta() });
    const { rerender } = render(tiles({ html: '<p>A' }));
    await screen.findAllByTestId('blitz-tile');
    let resolveSecond;
    openRender.mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));
    rerender(tiles({ html: '<p>A<mark>' }));
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('1%2F1%2F0');
    expect(closeRender).not.toHaveBeenCalled();
    await act(async () => resolveSecond({ docId: 2, rev: 1, meta: meta() }));
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('2%2F1%2F0');
    expect(closeRender).toHaveBeenCalledWith(1);
  });

  it('a shown tile past the first two keeps its src across a re-open (no blank flash)', async () => {
    let fire;
    globalThis.IntersectionObserver = class { constructor(cb) { fire = cb; } observe() {} unobserve() {} disconnect() {} };
    openRender.mockResolvedValueOnce({ docId: 1, rev: 1, meta: meta({ tileCount: 5, cssHeight: 2500 }) });
    const { rerender } = render(tiles({ html: '<p>A' }));
    await screen.findAllByTestId('blitz-tile');
    await act(async () => { fire([{ isIntersecting: true, target: screen.getAllByTestId('blitz-tile')[3] }]); });
    expect(screen.getAllByTestId('blitz-tile')[3].hasAttribute('src')).toBe(true);
    openRender.mockResolvedValueOnce({ docId: 2, rev: 1, meta: meta({ tileCount: 5, cssHeight: 2500 }) });
    rerender(tiles({ html: '<p>A<mark>' }));
    await waitFor(() => expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('2%2F1%2F0'));
    expect(screen.getAllByTestId('blitz-tile')[3].getAttribute('src')).toContain('2%2F1%2F3');
    expect(screen.getAllByTestId('blitz-tile')[4].hasAttribute('src')).toBe(false);
  });

  it('closes its doc on unmount', async () => {
    openRender.mockResolvedValue({ docId: 8, rev: 1, meta: meta() });
    const { unmount } = render(tiles());
    await screen.findAllByTestId('blitz-tile');
    unmount();
    expect(closeRender).toHaveBeenCalledWith(8);
  });

  it('a re-render with new callback identities does not reopen or close the doc', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: meta() });
    const { rerender } = render(tiles());
    await screen.findAllByTestId('blitz-tile');
    expect(openRender).toHaveBeenCalledTimes(1);
    rerender(tiles({ onFailure: vi.fn(), onLink: vi.fn() }));
    rerender(tiles({ onFailure: vi.fn(), onLink: vi.fn() }));
    await act(async () => {});
    expect(openRender).toHaveBeenCalledTimes(1);
    expect(closeRender).not.toHaveBeenCalled();
  });

  it('the latest onLink and onFailure are the ones called', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    hitRender.mockResolvedValue({ link: { href: 'https://y.test/', text: 'y', alert: null, title: null }, fold: null });
    const { rerender } = render(tiles({ onLink: first }));
    await screen.findAllByTestId('blitz-tile');
    rerender(tiles({ onLink: latest }));
    fireEvent.click(screen.getAllByTestId('blitz-tile')[0], { clientX: 5, clientY: 5 });
    await waitFor(() => expect(latest).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://y.test/' })));
    expect(first).not.toHaveBeenCalled();
  });

  describe('render.open parameters stay inside what the daemon accepts', () => {
    const lastOpen = () => openRender.mock.calls.at(-1)[0];
    const setDpr = (value) => Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });

    it('an ultrawide pane asks for 4000 css px, and lays out at the width the daemon answers', async () => {
      paneWidth = 5000;
      openRender.mockResolvedValue({ docId: 1, rev: 1, meta: meta({ cssWidth: 4000, tileCount: 1, cssHeight: 100 }) });
      render(tiles());
      const t = await screen.findAllByTestId('blitz-tile');
      expect(lastOpen().cssWidth).toBe(4000);
      expect(t[0].style.width).toBe('4000px');
      expect(t[0].parentElement.style.width).toBe('4000px');
    });
    it('a width the daemon sizes differently from the request is laid out at meta.cssWidth', async () => {
      paneWidth = 5000;
      openRender.mockResolvedValue({ docId: 1, rev: 1, meta: meta({ cssWidth: 3999, tileCount: 1, cssHeight: 100 }) });
      render(tiles());
      const t = await screen.findAllByTestId('blitz-tile');
      expect(t[0].parentElement.style.width).toBe('3999px');
    });
    it('a zoomed display ratio of 8 is capped at 4', async () => {
      setDpr(8);
      openRender.mockResolvedValue({ docId: 1, rev: 1, meta: meta() });
      render(tiles());
      await screen.findAllByTestId('blitz-tile');
      expect(lastOpen().scale).toBe(4);
    });
    it('a ratio of 0.2 is raised to 0.5', async () => {
      setDpr(0.2);
      openRender.mockResolvedValue({ docId: 1, rev: 1, meta: meta() });
      render(tiles());
      await screen.findAllByTestId('blitz-tile');
      expect(lastOpen().scale).toBe(0.5);
    });
    it('an ordinary pane and ratio go through unchanged', async () => {
      setDpr(1.5);
      paneWidth = 733;
      openRender.mockResolvedValue({ docId: 1, rev: 1, meta: meta() });
      render(tiles());
      await screen.findAllByTestId('blitz-tile');
      expect(lastOpen()).toMatchObject({ cssWidth: 733, scale: 1.5 });
    });
  });

  it('any open rejection is a failure, whatever it looks like (render_bad_request, a plain object, a string)', async () => {
    for (const rejection of [{ code: 'render_bad_request' }, 'render_bad_request', new Error('render_bad_request')]) {
      const onFailure = vi.fn();
      openRender.mockRejectedValueOnce(rejection);
      const { unmount } = render(tiles({ html: `<p>${onFailure.mock.calls.length}${Math.random()}`, onFailure }));
      await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
      expect(onFailure).toHaveBeenCalledWith('render_bad_request');
      unmount();
    }
  });
  it('a click that ends a drag-selection never opens a link', async () => {
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
    hitRender.mockResolvedValue({ link: { href: 'https://x.test/' }, fold: null });
    const onLink = vi.fn();
    render(tiles({ onLink }));
    const span = await screen.findByText('hello');
    const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 3);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    fireEvent.click(span);
    await new Promise(res => setTimeout(res, 0));
    expect(onLink).not.toHaveBeenCalled();
  });

  it('a drag is serialized when the pointer is released, not while it is still down', async () => {
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
    serializeRender.mockResolvedValue({ html: '<p>hel</p>', text: 'hel' });
    render(tiles());
    const span = await screen.findByText('hello');
    fireEvent.pointerDown(span);
    const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 3);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(res => setTimeout(res, 250));
    expect(serializeRender).not.toHaveBeenCalled();
    fireEvent.pointerUp(span);
    await waitFor(() => expect(serializeRender).toHaveBeenCalledWith(5, { node: 1, offset: 0 }, { node: 1, offset: 3 }));
  });

  it('a selection is serialized by endpoints and copy writes both formats', async () => {
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'héllo', fontPx: 16, node: 1, start: 0 }] });
    serializeRender.mockResolvedValue({ html: '<p>h&eacute;l</p>', text: 'hél' });
    render(tiles());
    const span = await screen.findByText('héllo');
    const r = document.createRange(); r.setStart(span.firstChild, 1); r.setEnd(span.firstChild, 3);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    await waitFor(() => expect(serializeRender).toHaveBeenCalledWith(5, { node: 1, offset: 1 }, { node: 1, offset: 4 }));
    const data = {};
    const e = new Event('copy', { cancelable: true });
    e.clipboardData = { setData: (t, v) => { data[t] = v; } };
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(data).toEqual({ 'text/html': '<p>h&eacute;l</p>', 'text/plain': 'hél' });
  });

  describe('body keyboard', () => {
    const run = (i) => ({ runs: [{ x: 0, y: i * 512, w: 30, h: 20, text: `t${i}`, fontPx: 16, node: 10 + i, start: 0 }] });

    it('select all loads every tile first, then selects first to last span', async () => {
      openRender.mockResolvedValue({ docId: 3, rev: 1, meta: meta({ tileCount: 3 }) });
      textRunsRender.mockImplementation(async (_d, i) => run(i));
      globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }; // only tiles 0,1 shown
      render(tiles());
      const body = await screen.findByTestId('blitz-email-body');
      fireEvent.keyDown(body, { key: 'a', metaKey: true, ctrlKey: true });
      // The spans of the never-shown tile commit after loadAll resolves, so wait for the selection.
      await waitFor(() => expect(window.getSelection().toString()).toContain('t2'));
      expect(textRunsRender.mock.calls.map(c => c[1]).sort()).toEqual([0, 1, 2]);
    });

    it('select all stays inside the body: nothing outside the text layer is selected', async () => {
      openRender.mockResolvedValue({ docId: 3, rev: 1, meta: meta({ tileCount: 3 }) });
      textRunsRender.mockImplementation(async (_d, i) => run(i));
      render(<div><p data-testid="chrome">app chrome</p>{tiles()}</div>);
      const body = await screen.findByTestId('blitz-email-body');
      fireEvent.keyDown(body, { key: 'a', metaKey: true, ctrlKey: true });
      const sel = window.getSelection();
      await waitFor(() => expect(sel.toString()).toContain('t2'));
      expect(sel.toString()).not.toContain('app chrome');
      expect(sel.getRangeAt(0).intersectsNode(screen.getByTestId('chrome'))).toBe(false);
    });

    it('select all is serialized ahead, so the following Cmd+C copies rich and plain from the warm cache', async () => {
      openRender.mockResolvedValue({ docId: 3, rev: 1, meta: meta({ tileCount: 3 }) });
      textRunsRender.mockImplementation(async (_d, i) => run(i));
      serializeRender.mockResolvedValue({ html: '<p>t0 t1 t2</p>', text: 't0\nt1\nt2' });
      render(tiles());
      const body = await screen.findByTestId('blitz-email-body');
      fireEvent.keyDown(body, { key: 'a', metaKey: true, ctrlKey: true });
      await waitFor(() => expect(serializeRender).toHaveBeenCalledWith(3, { node: 10, offset: 0 }, { node: 12, offset: 2 }));
      // Cmd+C: the keydown is not prevented, so the webview fires the copy event.
      expect(fireEvent.keyDown(body, { key: 'c', metaKey: true, ctrlKey: true })).toBe(true);
      const data = {};
      const e = new Event('copy', { cancelable: true });
      e.clipboardData = { setData: (t, v) => { data[t] = v; } };
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(data).toEqual({ 'text/html': '<p>t0 t1 t2</p>', 'text/plain': 't0\nt1\nt2' });
    });

    it('Escape clears the body selection and stays at the body', async () => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
      render(tiles());
      const span = await screen.findByText('hello');
      const r = document.createRange(); r.selectNodeContents(span);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
      const app = vi.fn();
      window.addEventListener('keydown', app);
      fireEvent.keyDown(screen.getByTestId('blitz-email-body'), { key: 'Escape' });
      window.removeEventListener('keydown', app);
      expect(window.getSelection().rangeCount === 0 || window.getSelection().isCollapsed).toBe(true);
      expect(app).not.toHaveBeenCalled();
    });

    it('the body takes focus like the iframe, draws no ring, and app keys stop at it', async () => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      render(tiles());
      const body = await screen.findByTestId('blitz-email-body');
      expect(body.getAttribute('tabindex')).toBe('-1');
      expect(body.style.outline).toBe('none');
      expect(body.getAttribute('role')).toBeNull();
      body.focus();
      expect(document.activeElement).toBe(body);
      const app = vi.fn();
      window.addEventListener('keydown', app);
      fireEvent.keyDown(body, { key: 'j' });
      expect(app).not.toHaveBeenCalled();
      fireEvent.keyDown(body, { key: 'Tab' });
      expect(app).toHaveBeenCalledTimes(1);
      window.removeEventListener('keydown', app);
    });
  });

  it('exposes layerEl: the text layer element, null before a doc opens', async () => {
    const ref = React.createRef();
    let resolve;
    openRender.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(tiles({ ref }));
    expect(ref.current.layerEl()).toBeNull();
    await act(async () => resolve({ docId: 1, rev: 1, meta: meta() }));
    const layer = await screen.findByTestId('blitz-text-layer');
    expect(ref.current.layerEl()).toBe(layer);
  });

  describe('selectionText (what a reply quotes)', () => {
    const lines = [
      { x: 0, y: 0, w: 50, h: 20, text: 'one\n', fontPx: 16, node: 1, start: 0, seg: 0 },
      { x: 0, y: 20, w: 50, h: 20, text: 'two', fontPx: 16, node: 1, start: 4, seg: 4 },
    ];
    const selectLines = () => {
      const [a, b] = document.querySelectorAll('span[data-node]');
      const r = document.createRange(); r.setStart(a.firstChild, 0); r.setEnd(b.firstChild, 3);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    };
    afterEach(() => window.getSelection().removeAllRanges());

    it('is the serialized plain text of the current selection once it has landed', async () => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      textRunsRender.mockResolvedValue({ runs: lines });
      serializeRender.mockResolvedValue({ html: 'one<br>two', text: 'serialized one\ntwo' });
      const ref = React.createRef();
      render(tiles({ ref }));
      await screen.findByText('two');
      selectLines();
      document.dispatchEvent(new Event('selectionchange'));
      await waitFor(() => expect(serializeRender).toHaveBeenCalledWith(5, { node: 1, offset: 0 }, { node: 1, offset: 7 }));
      await waitFor(() => expect(ref.current.selectionText()).toBe('serialized one\ntwo'));
    });

    it('before serialize has landed it is the layer text, with its hard newlines', async () => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      textRunsRender.mockResolvedValue({ runs: lines });
      serializeRender.mockImplementation(() => new Promise(() => {}));
      const ref = React.createRef();
      render(tiles({ ref }));
      await screen.findByText('two');
      selectLines();
      expect(ref.current.selectionText()).toBe('one\ntwo');
    });

    it('is empty with no selection in the body, and before a doc opens', async () => {
      const ref = React.createRef();
      let resolve;
      openRender.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
      render(tiles({ ref }));
      expect(ref.current.selectionText()).toBe('');
      await act(async () => resolve({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) }));
      window.getSelection().removeAllRanges();
      expect(ref.current.selectionText()).toBe('');
    });
  });

  describe('reply quote from the text layer', () => {
    const runs = (over = {}) => [
      { x: 0, y: 0, w: 50, h: 20, text: 'Hello ', fontPx: 16, node: 1, start: 0, ...over },
      { x: 50, y: 0, w: 50, h: 20, text: 'world', fontPx: 16, node: 1, start: 6, ...over },
    ];
    const select = (a, aOff, b, bOff) => {
      const r = document.createRange(); r.setStart(a.firstChild, aOff); r.setEnd(b.firstChild, bOff);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    };
    afterEach(() => window.getSelection().removeAllRanges());

    it('is the selected text only: none of the layer markup, positions or classes reach the quote', async () => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      textRunsRender.mockResolvedValue({ runs: runs() });
      const ref = React.createRef();
      render(tiles({ ref }));
      const first = await screen.findByText('Hello');
      select(first, 3, screen.getByText('world'), 3);
      const quote = replySelection(ref.current.layerEl(), document.getSelection());
      expect(quote).toBe('lo wor');
      // The layer's own markup is real, so the check below can fail.
      expect(ref.current.layerEl().innerHTML).toMatch(/letter-spacing|left:|mv-blitz/);
      expect(quote).not.toMatch(/<span|left:|top:|letter-spacing|transparent|mv-blitz|style=|class=|data-/);
    });

    it('still quotes the same selection after a relayout (rev bump keeps the runs)', async () => {
      let push;
      onRenderUpdated.mockImplementation(async cb => { push = cb; return () => {}; });
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
      textRunsRender.mockResolvedValue({ runs: runs() });
      const ref = React.createRef();
      render(tiles({ ref }));
      select(await screen.findByText('Hello'), 3, screen.getByText('world'), 3);
      let resolve2;
      textRunsRender.mockImplementationOnce(() => new Promise(r => { resolve2 = r; }));
      await act(async () => { push({ docId: 5, rev: 2, meta: meta({ tileCount: 1, cssHeight: 100 }) }); });
      // Reply while the new layout is in flight: the old spans are still there.
      expect(replySelection(ref.current.layerEl(), document.getSelection())).toBe('lo wor');
      await act(async () => { resolve2({ runs: runs({ y: 4 }) }); });
      expect(replySelection(ref.current.layerEl(), document.getSelection())).toBe('lo wor');
    });
  });
});

describe('fold toggles', () => {
  const foldMeta = (open) => meta({ folds: [{ id: 'q0', kind: 'quote', open }, { id: 's0', kind: 'signature', open: false }] });

  it('click on a toggle folds through the worker; the render-updated event swaps rev/meta; no link opens', async () => {
    let push;
    onRenderUpdated.mockImplementation(async cb => { push = cb; return () => {}; });
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    foldRender.mockResolvedValue({ rev: 2, meta: foldMeta(true) });
    const onLink = vi.fn();
    const onFoldToggled = vi.fn();
    render(tiles({ onLink, onFoldToggled }));
    const imgs = await screen.findAllByTestId('blitz-tile');
    fireEvent.click(imgs[0], { clientX: 5, clientY: 5 });
    await waitFor(() => expect(foldRender).toHaveBeenCalledWith(4, 'q0', true));
    await waitFor(() => expect(onFoldToggled).toHaveBeenCalledWith('q0', true));
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('4%2F1%2F0'); // reply not applied
    await act(async () => { push({ docId: 4, rev: 2, meta: foldMeta(true) }); });
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('4%2F2%2F0');
    expect(onLink).not.toHaveBeenCalled();
  });

  it('a second click closes it again (open state read from meta.folds)', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(true) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    render(tiles());
    fireEvent.click((await screen.findAllByTestId('blitz-tile'))[0]);
    await waitFor(() => expect(foldRender).toHaveBeenCalledWith(4, 'q0', false));
  });

  it('hover over a quote toggle shows pointer and the iframe title; signature has no title', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValueOnce({ link: null, fold: 'q0' }).mockResolvedValueOnce({ link: null, fold: 's0' });
    render(tiles());
    const layer = await screen.findByTestId('blitz-text-layer');
    fireEvent.mouseMove(layer, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(layer.getAttribute('data-hover')).toBe('true'));
    expect(layer.closest('[title]')?.getAttribute('title')).toBe('Show quoted text');
    fireEvent.mouseMove(layer, { clientX: 5, clientY: 300 });
    await waitFor(() => expect(layer.closest('[title]')).toBeNull());
  });

  it('an open quote toggle hides with the hide title; leaving the body clears hover and title', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(true) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    render(tiles());
    const layer = await screen.findByTestId('blitz-text-layer');
    fireEvent.mouseMove(layer, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(layer.closest('[title]')?.getAttribute('title')).toBe('Hide quoted text'));
    expect(layer.closest('[role=presentation]').style.cursor).toBe('pointer');
    fireEvent.mouseLeave(layer.closest('[role=presentation]'));
    await waitFor(() => expect(layer.closest('[title]')).toBeNull());
    expect(layer.getAttribute('data-hover')).toBeNull();
    expect(layer.closest('[role=presentation]').style.cursor).toBe('default');
  });

  it('a toggle inside a link folds and never opens the link; no URL chip for it', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: { href: 'https://x.test/' }, fold: 'q0' });
    const onLink = vi.fn();
    render(tiles({ onLink }));
    const layer = await screen.findByTestId('blitz-text-layer');
    fireEvent.mouseMove(layer, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(layer.getAttribute('data-hover')).toBe('true'));
    expect(screen.queryByTestId('blitz-link-chip')).toBeNull();
    fireEvent.click((await screen.findAllByTestId('blitz-tile'))[0]);
    await waitFor(() => expect(foldRender).toHaveBeenCalledWith(4, 'q0', true));
    expect(onLink).not.toHaveBeenCalled();
  });

  it('a click that ends a drag-selection never toggles a fold', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: { ...foldMeta(false), tileCount: 1, cssHeight: 100 } });
    textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    const onFoldToggled = vi.fn();
    render(tiles({ onFoldToggled }));
    const span = await screen.findByText('hello');
    const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 3);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    fireEvent.click(span);
    await new Promise(res => setTimeout(res, 0));
    expect(foldRender).not.toHaveBeenCalled();
    expect(onFoldToggled).not.toHaveBeenCalled();
    window.getSelection().removeAllRanges();
  });

  it('a rejected fold reverts the recorded state and does not throw; the next click works', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    foldRender.mockRejectedValueOnce(new Error('render_unknown_doc')).mockResolvedValue({ rev: 1, meta: {} });
    const onFoldToggled = vi.fn();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(tiles({ onFoldToggled }));
    const img = (await screen.findAllByTestId('blitz-tile'))[0];
    fireEvent.click(img);
    await waitFor(() => expect(onFoldToggled.mock.calls).toEqual([['q0', true], ['q0', false]]));
    expect(debug).toHaveBeenCalled();
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(2));
    debug.mockRestore();
  });

  it('a stale double click re-sends the same state and leaves nothing pending', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    foldRender.mockResolvedValue({ rev: 1, meta: {} }); // idempotent no-op: no updated event ever comes
    render(tiles());
    const img = (await screen.findAllByTestId('blitz-tile'))[0];
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(1));
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(2));
    expect(foldRender.mock.calls.map(c => c[2])).toEqual([true, true]);
  });

  it('a refusal of an earlier click does not revert a later click on the same fold', async () => {
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    let rejectFirst;
    foldRender.mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej; }))
      .mockResolvedValueOnce({ rev: 1, meta: {} });
    const onFoldToggled = vi.fn();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(tiles({ onFoldToggled }));
    const img = (await screen.findAllByTestId('blitz-tile'))[0];
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(1));
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(2));
    await act(async () => { rejectFirst(new Error('transient')); });
    expect(onFoldToggled.mock.calls).toEqual([['q0', true], ['q0', true]]);
    debug.mockRestore();
  });

  it('a refusal that lands after the doc was replaced reverts nothing', async () => {
    openRender.mockResolvedValueOnce({ docId: 4, rev: 1, meta: foldMeta(false) })
      .mockResolvedValue({ docId: 5, rev: 1, meta: foldMeta(true) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    let rejectIt;
    foldRender.mockImplementationOnce(() => new Promise((_, rej) => { rejectIt = rej; }));
    const onFoldToggled = vi.fn();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { rerender } = render(tiles({ onFoldToggled, html: '<p>A' }));
    fireEvent.click((await screen.findAllByTestId('blitz-tile'))[0]);
    await waitFor(() => expect(foldRender).toHaveBeenCalledWith(4, 'q0', true));
    rerender(tiles({ onFoldToggled, html: '<p>B' }));
    await waitFor(() => expect(screen.getByTestId('blitz-email-body').getAttribute('data-doc-id')).toBe('5'));
    await act(async () => { rejectIt(new Error('render_unknown_doc')); });
    expect(onFoldToggled.mock.calls).toEqual([['q0', true]]);
    debug.mockRestore();
  });

  it('a click after the fold state changed (render-updated between clicks) toggles it back', async () => {
    let push;
    onRenderUpdated.mockImplementation(async cb => { push = cb; return () => {}; });
    openRender.mockResolvedValue({ docId: 4, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    foldRender.mockResolvedValue({ rev: 2, meta: {} });
    render(tiles());
    const img = (await screen.findAllByTestId('blitz-tile'))[0];
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(1));
    await act(async () => { push({ docId: 4, rev: 2, meta: foldMeta(true) }); });
    fireEvent.click(img);
    await waitFor(() => expect(foldRender).toHaveBeenCalledTimes(2));
    expect(foldRender.mock.calls.map(c => c[2])).toEqual([true, false]);
  });

  it('a new doc starts with no hover: the old toggle id is not under the pointer any more', async () => {
    openRender.mockResolvedValueOnce({ docId: 4, rev: 1, meta: foldMeta(false) })
      .mockResolvedValue({ docId: 5, rev: 1, meta: foldMeta(false) });
    hitRender.mockResolvedValue({ link: null, fold: 'q0' });
    const { rerender } = render(tiles({ html: '<p>A' }));
    const layer = await screen.findByTestId('blitz-text-layer');
    fireEvent.mouseMove(layer, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(layer.closest('[title]')?.getAttribute('title')).toBe('Show quoted text'));
    rerender(tiles({ html: '<p>B' }));
    await waitFor(() => expect(screen.getByTestId('blitz-email-body').getAttribute('data-doc-id')).toBe('5'));
    const layer2 = screen.getByTestId('blitz-text-layer');
    expect(layer2.closest('[title]')).toBeNull();
    expect(layer2.getAttribute('data-hover')).toBeNull();
    expect(layer2.closest('[role=presentation]').style.cursor).toBe('default');
  });
});

describe('body context menu', () => {
  const foldMeta = () => meta({ folds: [{ id: 'q0', kind: 'quote', open: false }] });
  const rightClick = async (hit, props) => {
    openRender.mockResolvedValue({ docId: 2, rev: 1, meta: foldMeta() });
    hitRender.mockResolvedValue(hit);
    render(tiles(props));
    const tileEls = await screen.findAllByTestId('blitz-tile');
    const ev = fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 });
    return { tileEls, ev };
  };

  it('right-click opens the body menu at the point with Copy Link over a link; next click closes it', async () => {
    openRender.mockResolvedValue({ docId: 2, rev: 1, meta: meta() });
    hitRender.mockResolvedValue({ link: { href: 'https://x.test/' }, fold: null });
    render(tiles());
    const tileEls = await screen.findAllByTestId('blitz-tile');
    const ev = fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 });
    expect(ev).toBe(false); // native menu suppressed
    const menu = await screen.findByTestId('blitz-context-menu');
    expect(screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent)).toContain('Copy Link');
    expect(menu.style.position).toBe('fixed'); // out of the body's clipping box
    fireEvent.click(tileEls[0]);
    await waitFor(() => expect(screen.queryByTestId('blitz-context-menu')).toBeNull());
  });

  it('the click that closes the menu opens no link', async () => {
    const onLink = vi.fn();
    const { tileEls } = await rightClick({ link: { href: 'https://x.test/' }, fold: null }, { onLink });
    await screen.findByTestId('blitz-context-menu');
    fireEvent.click(tileEls[0]);
    await waitFor(() => expect(screen.queryByTestId('blitz-context-menu')).toBeNull());
    await act(async () => {});
    expect(onLink).not.toHaveBeenCalled();
    expect(hitRender).toHaveBeenCalledTimes(1); // only the right-click hit-tested
  });

  it('off a link there is no Copy Link; over a fold toggle there is none either, even inside a link', async () => {
    await rightClick({ link: null, fold: null });
    await screen.findByTestId('blitz-context-menu');
    expect(screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent)).toEqual(['Copy', 'Select All']);
    cleanup();
    await rightClick({ link: { href: 'https://x.test/' }, fold: 'q0' });
    await screen.findByTestId('blitz-context-menu');
    expect(screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent)).toEqual(['Copy', 'Select All']);
  });

  it('a hit that never answers still opens the menu, without Copy Link', async () => {
    vi.useFakeTimers();
    try {
      openRender.mockResolvedValue({ docId: 2, rev: 1, meta: foldMeta() });
      hitRender.mockReturnValue(new Promise(() => {}));
      render(tiles());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const tileEls = screen.getAllByTestId('blitz-tile');
      fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 });
      await act(async () => { await vi.advanceTimersByTimeAsync(301); });
      expect(screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent)).toEqual(['Copy', 'Select All']);
    } finally { vi.useRealTimers(); }
  });

  describe('a hit that answers after the menu opened', () => {
    const linkHit = { link: { href: 'https://x.test/' }, fold: null };
    const labels = () => screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent);
    const setupLate = async () => {
      vi.useFakeTimers();
      openRender.mockResolvedValue({ docId: 2, rev: 1, meta: foldMeta() });
      const pending = [];
      hitRender.mockImplementation(() => new Promise(r => { pending.push(r); }));
      render(tiles());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      return { tileEls: screen.getAllByTestId('blitz-tile'), pending };
    };

    it('adds Copy Link in place when the hit lands while the menu is still open', async () => {
      try {
        const { tileEls, pending } = await setupLate();
        fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 });
        await act(async () => { await vi.advanceTimersByTimeAsync(301); });
        expect(labels()).toEqual(['Copy', 'Select All']);
        const menu = screen.getByTestId('blitz-context-menu');
        await act(async () => { pending[0](linkHit); await vi.advanceTimersByTimeAsync(0); });
        expect(labels()).toEqual(['Copy', 'Copy Link', 'Select All']);
        expect(screen.getByTestId('blitz-context-menu')).toBe(menu); // the same menu, not a reopened one
      } finally { vi.useRealTimers(); }
    });

    it('a late fold hit adds nothing', async () => {
      try {
        const { tileEls, pending } = await setupLate();
        fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 });
        await act(async () => { await vi.advanceTimersByTimeAsync(301); });
        await act(async () => { pending[0]({ link: { href: 'https://x.test/' }, fold: 'q0' }); await vi.advanceTimersByTimeAsync(0); });
        expect(labels()).toEqual(['Copy', 'Select All']);
      } finally { vi.useRealTimers(); }
    });

    it('a late hit after the menu closed, or for an older right-click, is ignored', async () => {
      try {
        const { tileEls, pending } = await setupLate();
        fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 });
        await act(async () => { await vi.advanceTimersByTimeAsync(301); });
        fireEvent.click(tileEls[0]); // closes the menu
        expect(screen.queryByTestId('blitz-context-menu')).toBeNull();
        await act(async () => { pending[0](linkHit); await vi.advanceTimersByTimeAsync(0); });
        expect(screen.queryByTestId('blitz-context-menu')).toBeNull();

        fireEvent.contextMenu(tileEls[0], { clientX: 40, clientY: 50 }); // pending[1]
        await act(async () => { await vi.advanceTimersByTimeAsync(301); });
        fireEvent.contextMenu(tileEls[0], { clientX: 90, clientY: 95 }); // pending[2], supersedes it
        await act(async () => { pending[1](linkHit); await vi.advanceTimersByTimeAsync(0); });
        expect(labels()).toEqual(['Copy', 'Select All']); // the first menu is still up, untouched
        await act(async () => { await vi.advanceTimersByTimeAsync(301); });
        expect(labels()).toEqual(['Copy', 'Select All']);
        await act(async () => { pending[2](linkHit); await vi.advanceTimersByTimeAsync(0); });
        expect(labels()).toEqual(['Copy', 'Copy Link', 'Select All']);
      } finally { vi.useRealTimers(); }
    });
  });

  it('moving the pointer over the menu does not hit-test the body behind it', async () => {
    await rightClick({ link: null, fold: null });
    const menu = await screen.findByTestId('blitz-context-menu');
    hitRender.mockClear();
    fireEvent.mouseMove(menu, { clientX: 50, clientY: 60 });
    await act(async () => {});
    expect(hitRender).not.toHaveBeenCalled();
  });

  describe('placement', () => {
    // jsdom lays nothing out: the menu's rect follows its own left/top (180x110), the body box is `box` at the window origin.
    let rectSpy; let wSpy; let hSpy; let box;
    beforeEach(() => {
      box = { left: 0, top: 0, right: 600, bottom: 1100, width: 600, height: 1100 };
      rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
        if (this.dataset?.testid === 'blitz-context-menu') {
          const left = parseFloat(this.style.left); const top = parseFloat(this.style.top);
          return { left, top, right: left + 180, bottom: top + 110, width: 180, height: 110 };
        }
        return box;
      });
      wSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180);
      hSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(110);
    });
    afterEach(() => { rectSpy.mockRestore(); wSpy.mockRestore(); hSpy.mockRestore(); });

    it('opens at the pointer when it fits', async () => {
      await rightClick({ link: null, fold: null });
      const menu = await screen.findByTestId('blitz-context-menu');
      expect([menu.style.left, menu.style.top]).toEqual(['40px', '50px']);
    });

    it('is clamped into the window, like the iframe menu, and a second right-click moves the one menu', async () => {
      const { tileEls } = await rightClick({ link: null, fold: null });
      await screen.findByTestId('blitz-context-menu');
      fireEvent.contextMenu(tileEls[0], { clientX: 590, clientY: 760 });
      // window is 1024x768: bottom to the window height minus the 8px margin; the right edge still fits
      await waitFor(() => expect(screen.getByTestId('blitz-context-menu').style.top).toBe('650px'));
      expect(screen.getByTestId('blitz-context-menu').style.left).toBe('590px');
      fireEvent.contextMenu(tileEls[0], { clientX: 1000, clientY: 20 });
      await waitFor(() => expect(screen.getByTestId('blitz-context-menu').style.left).toBe('836px'));
      expect(screen.getAllByTestId('blitz-context-menu')).toHaveLength(1);
    });

    it('over a body shorter than the menu it is not squeezed into the body and not clipped by it', async () => {
      box = { left: 0, top: 0, right: 600, bottom: 40, width: 600, height: 40 };
      await rightClick({ link: { href: 'https://x.test/' }, fold: null });
      const menu = await screen.findByTestId('blitz-context-menu');
      // all three items, at the pointer (not pinned to the 40px box's top margin)
      expect(screen.getAllByTestId('blitz-ctx-item')).toHaveLength(3);
      expect([menu.style.left, menu.style.top]).toEqual(['40px', '50px']);
      // The body box is overflow-x/y auto and would clip it: the menu lives outside it.
      expect(menu.closest('[data-renderer="blitz"]')).toBeNull();
      for (let el = menu.parentElement; el; el = el.parentElement) expect(el.className).not.toMatch(/overflow-/);
    });
  });

  it('Copy goes through the copy event (the controller writes rich and plain); Select all selects the body', async () => {
    openRender.mockResolvedValue({ docId: 3, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
    serializeRender.mockResolvedValue({ html: '<p>hello</p>', text: 'hello' });
    hitRender.mockResolvedValue({ link: null, fold: null });
    const exec = vi.fn((cmd) => {
      if (cmd !== 'copy') return false;
      const e = new Event('copy', { cancelable: true });
      e.clipboardData = { setData: (t, v) => { exec.data[t] = v; } };
      document.dispatchEvent(e);
      return true;
    });
    exec.data = {};
    document.execCommand = exec;
    render(tiles());
    const span = await screen.findByText('hello');
    const tileEls = await screen.findAllByTestId('blitz-tile');
    fireEvent.contextMenu(tileEls[0], { clientX: 5, clientY: 5 });
    await screen.findByTestId('blitz-context-menu');
    fireEvent.click(screen.getAllByTestId('blitz-ctx-item')[1]); // Select All
    await waitFor(() => expect(window.getSelection().toString()).toContain('hello'));
    await waitFor(() => expect(serializeRender).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('blitz-context-menu')).toBeNull());
    fireEvent.contextMenu(tileEls[0], { clientX: 5, clientY: 5 });
    await screen.findByTestId('blitz-context-menu');
    fireEvent.click(screen.getAllByTestId('blitz-ctx-item')[0]); // Copy
    expect(exec).toHaveBeenCalledWith('copy');
    expect(exec.data).toEqual({ 'text/html': '<p>hello</p>', 'text/plain': 'hello' });
    expect(span).toBeTruthy();
    window.getSelection().removeAllRanges();
  });

  it('Escape closes the menu first and keeps the selection; the next Escape clears it', async () => {
    openRender.mockResolvedValue({ docId: 3, rev: 1, meta: meta({ tileCount: 1, cssHeight: 100 }) });
    textRunsRender.mockResolvedValue({ runs: [{ x: 0, y: 0, w: 50, h: 20, text: 'hello', fontPx: 16, node: 1, start: 0 }] });
    hitRender.mockResolvedValue({ link: null, fold: null });
    render(tiles());
    const span = await screen.findByText('hello');
    const r = document.createRange(); r.selectNodeContents(span);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    const tileEls = await screen.findAllByTestId('blitz-tile');
    fireEvent.contextMenu(tileEls[0], { clientX: 5, clientY: 5 });
    await screen.findByTestId('blitz-context-menu');
    const body = screen.getByTestId('blitz-email-body');
    fireEvent.keyDown(body, { key: 'Escape' });
    expect(screen.queryByTestId('blitz-context-menu')).toBeNull();
    expect(window.getSelection().toString()).toBe('hello');
    fireEvent.keyDown(body, { key: 'Escape' });
    expect(window.getSelection().toString()).toBe('');
  });

  it('closes when the message changes, and a right-click answered after the switch opens nothing', async () => {
    let answer;
    openRender.mockResolvedValueOnce({ docId: 2, rev: 1, meta: foldMeta() }).mockResolvedValue({ docId: 3, rev: 1, meta: foldMeta() });
    hitRender.mockResolvedValue({ link: null, fold: null });
    const { rerender } = render(tiles({ html: '<p>A' }));
    let tileEls = await screen.findAllByTestId('blitz-tile');
    fireEvent.contextMenu(tileEls[0], { clientX: 5, clientY: 5 });
    await screen.findByTestId('blitz-context-menu');
    rerender(tiles({ html: '<p>B' }));
    await waitFor(() => expect(screen.getByTestId('blitz-email-body').getAttribute('data-doc-id')).toBe('3'));
    expect(screen.queryByTestId('blitz-context-menu')).toBeNull();
    hitRender.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    tileEls = screen.getAllByTestId('blitz-tile');
    fireEvent.contextMenu(tileEls[0], { clientX: 5, clientY: 5 });
    rerender(tiles({ html: '<p>C' }));
    await act(async () => { answer({ link: null, fold: null }); });
    await act(async () => {});
    expect(screen.queryByTestId('blitz-context-menu')).toBeNull();
  });

  it('never paints a URL, privacy or not (Copy Link is a label only)', async () => {
    await rightClick({ link: { href: 'https://calendly.com/jane-doe?name=Jane%20Doe' }, fold: null }, { privacy: true });
    await screen.findByTestId('blitz-context-menu');
    expect(document.body.textContent).not.toContain('jane-doe');
    expect(document.body.textContent).not.toContain('Jane');
  });
});

describe('dark mode (interim: light colours until plan B)', () => {
  const dark = (palette = 'graphite') => ({ dark: true, palette });
  const sel = () => screen.getByTestId('blitz-text-layer').style.getPropertyValue('--mv-blitz-sel-bg');
  const inactive = () => screen.getByTestId('blitz-text-layer').style.getPropertyValue('--mv-blitz-sel-inactive-bg');
  const LIGHT = (({ r, g, b, a }) => `rgba(${r}, ${g}, ${b}, ${a})`)(lightSelectionColor()); // this engine's highlight, blended

  beforeEach(() => {
    hitRender.mockResolvedValue({ link: null, fold: null });
    let doc = 0;
    openRender.mockImplementation(async () => ({ docId: ++doc, rev: 1, meta: meta() }));
  });
  let highlightSpy;
  const highlightIs = (color) => { highlightSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color }); };
  afterEach(() => { highlightSpy?.mockRestore(); highlightSpy = undefined; });

  it('mounting in dark mode creates no iframe anywhere in the document', async () => {
    const { rerender } = render(tiles({ theme: dark() }));
    await screen.findByTestId('blitz-text-layer');
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    rerender(tiles({ theme: dark('teal') }));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('paints the light selection in both modes, with the inactive-window variable set', async () => {
    const { rerender } = render(tiles({ theme: dark() }));
    await screen.findByTestId('blitz-text-layer');
    await waitFor(() => expect(sel()).toBe(LIGHT));
    expect(inactive()).not.toBe('');
    rerender(tiles({ theme: { dark: false, palette: 'graphite' } }));
    await waitFor(() => expect(screen.getByTestId('blitz-email-body').getAttribute('data-doc-id')).toBe('2'));
    await waitFor(() => expect(sel()).toBe(LIGHT));
  });

  it('the menu keeps the light colours in dark mode', async () => {
    render(tiles({ theme: dark() }));
    fireEvent.contextMenu((await screen.findAllByTestId('blitz-tile'))[0], { clientX: 40, clientY: 50 });
    expect((await screen.findByTestId('blitz-context-menu')).style.background).toContain('rgb(255, 255, 255)');
  });

  it('an open menu closes on a theme flip and on a palette flip', async () => {
    const { rerender } = render(tiles({ theme: dark('graphite') }));
    const open = async () => {
      fireEvent.contextMenu((await screen.findAllByTestId('blitz-tile'))[0], { clientX: 40, clientY: 50 });
      await screen.findByTestId('blitz-context-menu');
    };
    await open();
    rerender(tiles({ theme: dark('teal') }));
    await waitFor(() => expect(screen.queryByTestId('blitz-context-menu')).toBeNull());
    await open();
    rerender(tiles({ theme: { dark: false, palette: 'teal' } }));
    await waitFor(() => expect(screen.queryByTestId('blitz-context-menu')).toBeNull());
  });

  it('re-reads the system highlight when the window regains focus (accent colour change), in either mode', async () => {
    render(tiles({ theme: dark() }));
    await waitFor(() => expect(sel()).toBe(LIGHT));
    highlightIs('rgb(0, 96, 212)');
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(sel()).toBe('rgba(0, 56, 201, 0.8)');
  });
});
