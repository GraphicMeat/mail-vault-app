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

const meta = (over = {}) => ({ cssWidth: 600, cssHeight: 1100, tileCssHeight: 512, tileCount: 3, links: [], plainText: '', folds: [], ...over });
const tiles = (p = {}) => <BlitzTiles html="<p>x" theme={{ dark: false }} onLink={vi.fn()} onFailure={vi.fn()} sizing="content" {...p} />;

afterEach(cleanup); // vitest globals are off, so RTL does not unmount between tests

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ contentRect: { width: 600 }, target: el }]); } disconnect() {} };
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
});
