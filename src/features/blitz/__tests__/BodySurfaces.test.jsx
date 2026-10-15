// @vitest-environment jsdom
//
// BlitzBody and BlitzTiles on every AltBodyProps surface: the viewport and
// width gate, the surface theme, the busy / doc / masked root attributes, the
// registry-backed doc (churn, deferral), the quiet retry and inert links.
// The service and the pre-pass entry are stand-ins; the tiles and the
// registry are real.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor, fireEvent } from '@testing-library/react';

const svc = vi.hoisted(() => ({ opens: [], next: 1, meta: {}, hit: { link: null, fold: null } }));
vi.mock('../service', () => ({
  openRender: vi.fn((params) => new Promise((resolve, reject) => svc.opens.push({
    params,
    resolve: () => resolve({ docId: svc.next++, rev: 1, meta: { cssWidth: params.cssWidth, cssHeight: 900, tileCssHeight: 512, tileCount: 2, links: [], plainText: '', folds: [], ...svc.meta } }),
    reject,
  }))),
  closeRender: vi.fn(async () => {}),
  hitRender: vi.fn(async () => svc.hit),
  tileUrl: (d, r, i) => `mvrender://localhost/${d}%2F${r}%2F${i}`,
  onRenderUpdated: vi.fn(async () => () => {}),
  textRunsRender: vi.fn(async () => ({ runs: [] })),
  serializeRender: vi.fn(async () => ({ html: '', text: '' })),
  foldRender: vi.fn(async () => ({ rev: 1, meta: {} })),
  fontsRender: vi.fn(async (f) => ({ registered: f })),
}));
const priv = vi.hoisted(() => ({ active: false, hold: false }));
vi.mock('../prepass/privacyDict', () => ({ usePrivacyDict: () => ({ active: priv.active, dict: null, hold: priv.hold }) }));
// The mock pre-pass ignores the surface: it hands back the document as the surface gave it (scripts stripped).
vi.mock('../prepass/index', () => ({
  runPrepass: async (props) => ({
    html: (props.documentHtml ?? `<html><body>${props.bodyHtml}</body></html>`).replace(/<script[\s\S]*?<\/script>/gi, ''),
    doc: null,
  }),
}));

const { default: BlitzBody } = await import('../BlitzBody');
const { closeRender, hitRender, foldRender } = await import('../service');
const { getDocRegistry, _resetDocRegistryForTest } = await import('../surfaces/docRegistry');

let roWidth = 600;
let observers = [];
beforeEach(() => {
  svc.opens.length = 0; svc.next = 1; svc.meta = {}; svc.hit = { link: null, fold: null };
  priv.active = false; priv.hold = false; roWidth = 600; observers = [];
  vi.mocked(closeRender).mockClear();
  vi.mocked(hitRender).mockClear();
  vi.mocked(foldRender).mockClear();
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ contentRect: { width: roWidth }, target: el }]); } disconnect() {} };
  // Only the viewport gate waits for `near()`; the tiles' own observer (it observes <img data-index>) is never fired.
  globalThis.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { observers.push({ cb: this.cb, el, fired: false }); }
    unobserve() {} disconnect() {}
  };
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
});
afterEach(() => { cleanup(); _resetDocRegistryForTest(); });

const base = { messageKey: 'k1', bodyHtml: '<p>Body</p>', theme: { dark: false, palette: 'graphite' }, sizing: 'content', plainText: 'Plain fallback text' };
const settle = async () => { await act(async () => { await Promise.resolve(); while (svc.opens.length) svc.opens.shift().resolve(); await Promise.resolve(); }); };
// Waits for the pre-pass to hand the doc to the worker, then lets that open land.
const landed = async () => { await waitFor(() => expect(svc.opens.length).toBeGreaterThan(0)); await settle(); };
const root = () => document.querySelector('[data-renderer="blitz"]');
const near = () => act(() => {
  for (const o of observers) if (!o.fired && !o.el.hasAttribute('data-index')) { o.fired = true; o.cb([{ isIntersecting: true, target: o.el }]); }
});

describe('BlitzBody on every surface', () => {
  it('a surface document is drawn as given, minus scripts', async () => {
    render(<BlitzBody {...base} surface="bubble" documentHtml={'<html><body style="background:transparent"><p>Mine</p><script>x()</script></body></html>'} sizing={{ collapsedMax: 400 }} />);
    near();
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(svc.opens[0].params.html).toContain('<p>Mine</p>');
    expect(svc.opens[0].params.html).not.toMatch(/<script/i);
  });

  it('bubble paints on a transparent canvas and never in dark', async () => {
    render(<BlitzBody {...base} surface="bubble" theme={{ dark: true, palette: 'indigo' }} documentHtml="<html><body><p>x</p></body></html>" />);
    near();
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(svc.opens[0].params.theme.bg).toBeNull();
    expect(svc.opens[0].params.theme.mode).toBe('light');
  });

  it('preview is never dark either, but keeps its own canvas; a reader keeps the dark theme', async () => {
    render(<BlitzBody {...base} surface="preview" messageKey="k-prev" theme={{ dark: true, palette: 'graphite' }} />);
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(svc.opens[0].params.theme.mode).toBe('light');
    expect(svc.opens[0].params.theme.bg).not.toBeNull();
    cleanup();
    render(<BlitzBody {...base} surface="reader" messageKey="k-read" theme={{ dark: true, palette: 'graphite' }} />);
    await waitFor(() => expect(svc.opens).toHaveLength(2));
    expect(svc.opens[1].params.theme.mode).toBe('dark');
  });

  it('thread waits for the viewport and is not busy meanwhile; fullView opens at once', async () => {
    render(<BlitzBody {...base} surface="thread" />);
    await act(async () => {});
    expect(svc.opens).toHaveLength(0);
    // Not near yet means not busy: a capture must not wait on an overscan row.
    expect(root().getAttribute('aria-busy')).toBe('false');
    expect(root().hasAttribute('data-blitz-doc')).toBe(false);
    near();
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    cleanup();
    // A different body: the same html would join the thread's still-pending open (one doc key).
    render(<BlitzBody {...base} surface="fullView" sizing="fill" bodyHtml="<p>Full view body</p>" />);
    await waitFor(() => expect(svc.opens).toHaveLength(2));
  });

  it('never opens below MIN_OPEN_WIDTH, opens when it grows', async () => {
    roWidth = 0;
    const { unmount } = render(<BlitzBody {...base} surface="fullView" />);
    await act(async () => {});
    expect(svc.opens).toHaveLength(0);
    unmount();
    roWidth = 39;
    const second = render(<BlitzBody {...base} surface="fullView" />);
    await act(async () => {});
    expect(svc.opens).toHaveLength(0);
    second.unmount();
    roWidth = 120;
    render(<BlitzBody {...base} surface="fullView" />);
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(svc.opens[0].params.cssWidth).toBe(120);
  });

  it('a body measured late opens when it gets its width (the gate is a dependency of the pre-pass)', async () => {
    let cb;
    globalThis.ResizeObserver = class { constructor(c) { cb = c; } observe() {} disconnect() {} };
    render(<BlitzBody {...base} surface="fullView" />);
    await act(async () => {});
    expect(svc.opens).toHaveLength(0);
    roWidth = 300;
    act(() => { cb([{ contentRect: { width: 300 } }]); });
    // The tiles measure their own box: give them a observer that reports it.
    globalThis.ResizeObserver = class { constructor(c) { this.c = c; } observe(el) { this.c([{ contentRect: { width: 300 }, target: el }]); } disconnect() {} };
    await waitFor(() => expect(svc.opens).toHaveLength(1));
  });

  it('busy until the doc lands, then names it; content sizing is the doc height', async () => {
    render(<BlitzBody {...base} surface="fullView" style={{ minHeight: 100 }} />);
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(root().getAttribute('aria-busy')).toBe('true');
    expect(root().hasAttribute('data-blitz-doc')).toBe(false);
    await settle();
    expect(root().getAttribute('aria-busy')).toBe('false');
    expect(root().getAttribute('data-blitz-doc')).toBe(String(svc.next - 1));
    expect(root().getAttribute('data-blitz-surface')).toBe('fullView');
    expect(root().style.height).toBe('900px');
    expect(root().style.minHeight).toBe('100px');
    expect(document.querySelector('[data-blitz-tiles]').hasAttribute('data-capture-exclude')).toBe(true);
  });

  it('a scrolling sizing keeps the overflow-y-auto class on the root', async () => {
    render(<BlitzBody {...base} surface="fullView" sizing="fill" />);
    await landed();
    expect(root().className).toContain('overflow-y-auto');
    expect(root().style.height).toBe('100%');
  });

  it('collapsedMax caps the box at the cap and scrolls inside past it', async () => {
    render(<BlitzBody {...base} surface="bubble" sizing={{ collapsedMax: 400 }} documentHtml="<html><body><p>x</p></body></html>" />);
    near();
    await landed();
    expect(root().style.height).toBe('400px'); // the mock doc is 900 tall
    expect(root().style.overflowY).toBe('auto');
    expect(root().className).toContain('overflow-y-auto');
  });

  it('two bubbles sharing one doc both recover when it dies: neither is left busy', async () => {
    const doc = '<html><body><p>Thanks</p></body></html>';
    render(<>
      <BlitzBody {...base} surface="bubble" messageKey="b-a" documentHtml={doc} />
      <BlitzBody {...base} surface="bubble" messageKey="b-b" documentHtml={doc} />
    </>);
    near();
    await waitFor(() => expect(svc.opens).toHaveLength(1)); // one registry entry for both
    await settle();
    const roots = () => [...document.querySelectorAll('[data-renderer="blitz"]')];
    await waitFor(() => expect(roots().every(r => r.hasAttribute('data-blitz-doc'))).toBe(true));
    const [a, b] = [...document.querySelectorAll('[data-testid="blitz-tile"]')].filter(t => t.dataset.index === '0');
    // The worker restarted: each body's tile of the shared doc fails, each retries and discards the entry.
    act(() => { a.dispatchEvent(new Event('error')); });
    act(() => { b.dispatchEvent(new Event('error')); });
    await act(async () => { await Promise.resolve(); });
    for (let i = 0; i < 4 && svc.opens.length; i++) await settle();
    await waitFor(() => expect(roots().every(r => r.hasAttribute('data-blitz-doc') && r.getAttribute('aria-busy') === 'false')).toBe(true));
    expect(screen.queryByTestId('blitz-failure-notice')).toBeNull();
  });

  it('churn: stale opens never paint and are released', async () => {
    const { rerender, unmount } = render(<BlitzBody {...base} surface="fullView" bodyHtml="<p>A</p>" />);
    for (let i = 0; i < 20; i++) rerender(<BlitzBody {...base} surface="fullView" bodyHtml={`<p>${i % 2 ? 'A' : 'B'}</p>`} />);
    rerender(<BlitzBody {...base} surface="fullView" bodyHtml="<p>C</p>" />);
    await settle(); await settle();
    await waitFor(() => expect(root().getAttribute('aria-busy')).toBe('false'));
    const shown = Number(root().getAttribute('data-blitz-doc'));
    expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain(`${shown}%2F1%2F0`);
    unmount();
    expect(getDocRegistry().liveCount()).toBe(0);
    expect(getDocRegistry().openCount()).toBeLessThanOrEqual(8);
  });

  it('a lazy surface defers its doc on unmount and reuses it; every other surface closes it at once (F2)', async () => {
    const first = render(<BlitzBody {...base} surface="thread" />);
    near();
    await landed();
    const docId = Number(root().getAttribute('data-blitz-doc'));
    first.unmount();
    expect(getDocRegistry().deferredCount()).toBe(1);
    expect(closeRender).not.toHaveBeenCalled();
    render(<BlitzBody {...base} surface="thread" />);
    near();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(svc.opens).toHaveLength(0); // reused, no second open
    expect(root().getAttribute('data-blitz-doc')).toBe(String(docId));
    cleanup();
    _resetDocRegistryForTest();
    vi.mocked(closeRender).mockClear();
    const reader = render(<BlitzBody {...base} surface="reader" messageKey="k-reader" bodyHtml="<p>Reader body</p>" />);
    await landed();
    const readerDoc = Number(root().getAttribute('data-blitz-doc'));
    reader.unmount();
    expect(closeRender).toHaveBeenCalledWith(readerDoc);
    expect(getDocRegistry().deferredCount()).toBe(0);
  });

  it('privacy hold: busy, masked, no doc', async () => {
    priv.active = true; priv.hold = true;
    render(<BlitzBody {...base} surface="fullView" message={{ from: { name: 'Ann Lee', address: 'ann@x.test' } }} />);
    await act(async () => {});
    expect(root().getAttribute('aria-busy')).toBe('true');
    expect(root().getAttribute('data-blitz-masked')).toBe('true');
    expect(root().hasAttribute('data-blitz-doc')).toBe(false);
    expect(svc.opens).toHaveLength(0);
  });

  it('the masked flag follows the one privacy flag on the gate, the hold box and the tiles (F24)', async () => {
    priv.active = true;
    const { unmount } = render(<BlitzBody {...base} surface="thread" />);
    await act(async () => {});
    expect(root().getAttribute('data-blitz-masked')).toBe('true'); // gate closed, not near
    near();
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(root().getAttribute('data-blitz-masked')).toBe('true');
    unmount();
    priv.active = false;
    render(<BlitzBody {...base} surface="reader" messageKey="k-unmasked" bodyHtml="<p>Open</p>" />);
    await waitFor(() => expect(svc.opens).toHaveLength(2));
    expect(root().getAttribute('data-blitz-masked')).toBe('false');
  });

  it('first tile error retries once quietly, the second fails', async () => {
    render(<BlitzBody {...base} surface="fullView" />);
    await landed();
    const firstDoc = Number(root().getAttribute('data-blitz-doc'));
    // Two tiles of the doc fail in the same tick, before React re-renders: the second is the same failure, not a second one.
    act(() => { for (const tile of screen.getAllByTestId('blitz-tile')) tile.dispatchEvent(new Event('error')); });
    expect(closeRender).toHaveBeenCalledWith(firstDoc); // discarded, not kept for reuse
    // The discarded doc's tiles are gone at once, so a sibling tile still loading cannot fail the retry (F5).
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    await waitFor(() => expect(svc.opens).toHaveLength(1)); // one quiet reopen
    expect(screen.queryByText('Plain fallback text')).toBeNull();
    await settle();
    expect(root().getAttribute('data-blitz-doc')).not.toBe(String(firstDoc));
    act(() => { screen.getAllByTestId('blitz-tile')[0].dispatchEvent(new Event('error')); });
    await waitFor(() => expect(screen.getByText('Plain fallback text')).toBeTruthy());
    expect(screen.getByTestId('blitz-failure-notice')).toBeTruthy();
    expect(svc.opens).toHaveLength(0); // no third open
  });

  it('render_unknown_doc from open takes the same quiet retry; another open error fails at once', async () => {
    render(<BlitzBody {...base} surface="fullView" />);
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    await act(async () => { svc.opens.shift().reject(new Error('render_unknown_doc')); });
    await waitFor(() => expect(svc.opens).toHaveLength(1));
    expect(screen.queryByText('Plain fallback text')).toBeNull();
    await act(async () => { svc.opens.shift().reject(new Error('render_too_complex')); });
    await waitFor(() => expect(screen.getByText('Plain fallback text')).toBeTruthy());
  });

  describe('links', () => {
    const hover = async () => {
      const layer = (await screen.findAllByTestId('blitz-tile'))[0].parentElement;
      await act(async () => { fireEvent.mouseMove(layer, { clientX: 10, clientY: 10 }); });
      return layer;
    };

    it('with no onLink there is no link pointer, no chip, and a click opens nothing', async () => {
      svc.hit = { link: { href: 'https://example.test/', text: 'go' }, fold: null };
      render(<BlitzBody {...base} surface="original" />);
      await landed();
      const layer = await hover();
      expect(screen.queryByTestId('blitz-link-chip')).toBeNull();
      expect(layer.style.cursor).toBe('default');
      await act(async () => { fireEvent.click(layer, { clientX: 10, clientY: 10 }); });
      expect(hitRender).toHaveBeenCalled(); // the hit still runs for folds
    });

    it('with an onLink the chip shows and a click activates it', async () => {
      const onLink = vi.fn();
      svc.hit = { link: { href: 'https://example.test/', text: 'go' }, fold: null };
      render(<BlitzBody {...base} surface="reader" messageKey="k-link" onLink={onLink} />);
      await landed();
      const layer = await hover();
      expect(screen.getByTestId('blitz-link-chip')).toBeTruthy();
      expect(layer.style.cursor).toBe('pointer');
      await act(async () => { fireEvent.click(layer, { clientX: 10, clientY: 10 }); });
      expect(onLink).toHaveBeenCalledWith({ href: 'https://example.test/', text: 'go' });
    });

    it('with no onLink a fold still gets its pointer and its click', async () => {
      svc.meta = { folds: [{ id: 'q0', kind: 'quote', open: false }] };
      svc.hit = { link: null, fold: 'q0' };
      render(<BlitzBody {...base} surface="original" />);
      await landed();
      const layer = await hover();
      expect(layer.style.cursor).toBe('pointer');
      await act(async () => { fireEvent.click(layer, { clientX: 10, clientY: 10 }); });
      await waitFor(() => expect(foldRender).toHaveBeenCalledWith(expect.any(Number), 'q0', true));
    });
  });
});
