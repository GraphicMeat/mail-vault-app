// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
vi.mock('../service', () => ({
  openRender: vi.fn(), hitRender: vi.fn(), closeRender: vi.fn(),
  tileUrl: (d, r, i) => `mvrender://localhost/${d}%2F${r}%2F${i}`,
  onRenderUpdated: vi.fn(async () => () => {}),
}));
import { openRender, hitRender, closeRender, onRenderUpdated } from '../service';
import BlitzTiles from '../BlitzTiles';

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
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta() });
    hitRender.mockResolvedValue({ link: { href: 'https://x.test/', text: 'x', alert: null, title: null }, fold: null });
    render(tiles({ onLink }));
    const t = await screen.findAllByTestId('blitz-tile');
    fireEvent.click(t[0], { clientX: 10, clientY: 10 });
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://x.test/' })));
  });

  describe('the hover URL chip', () => {
    const hover = async (props) => {
      openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta() });
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
    openRender.mockResolvedValue({ docId: 5, rev: 1, meta: meta() });
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
});
