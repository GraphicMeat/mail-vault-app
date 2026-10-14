// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import React, { createRef } from 'react';
vi.mock('../../service', () => ({ textRunsRender: vi.fn() }));
import { textRunsRender } from '../../service';
import TextLayer from '../TextLayer';
import { utf8Length, utf16ToUtf8, graphemeCount, fitRun } from '../textMetrics';

const meta = { cssWidth: 600, cssHeight: 1100, tileCssHeight: 512, tileCount: 3, links: [], folds: [] };
const run = (o) => ({ x: 0, y: 0, w: 70, h: 30, text: 'abcdefg', fontPx: 20, node: 5, start: 0, ...o });
const measure = (text, px) => text.length * px * 0.5; // a fake font: 0.5em per code unit

afterEach(cleanup); // vitest globals are off, so RTL does not unmount between tests
beforeEach(() => vi.clearAllMocks());

describe('textMetrics', () => {
  it('utf8 lengths and utf16 -> utf8 offsets across non-ASCII, emoji and ZWJ', () => {
    const s = 'naïve 😀 東京 👩‍👩‍👧';
    expect(utf8Length('naïve')).toBe(6);
    expect(utf16ToUtf8(s, 0)).toBe(0);
    expect(utf16ToUtf8(s, 6)).toBe(7);            // after "naïve "
    expect(utf16ToUtf8(s, 8)).toBe(11);           // after the emoji (2 code units, 4 bytes)
    expect(utf16ToUtf8(s, 7)).toBe(7);            // inside a surrogate pair: snaps back, never splits
    expect(utf16ToUtf8(s, s.length)).toBe(utf8Length(s));
  });
  it('graphemeCount treats a ZWJ family as one', () => {
    expect(graphemeCount('👩‍👩‍👧a')).toBe(2);
  });
  it('fitRun spreads the difference over graphemes', () => {
    expect(fitRun(run({ w: 84 }), measure)).toEqual({ letterSpacing: 2, width: 84 });
  });
  it('fitRun never divides by zero', () => {
    const r = fitRun(run({ text: '́', w: 0.5 }), () => 0);
    expect(Number.isFinite(r.letterSpacing)).toBe(true);
    expect(fitRun(run({ text: '', w: 3 }), measure).letterSpacing).toBe(0);
  });
});

describe('TextLayer', () => {
  it('fetches runs for shown tiles only and renders one span per run in a root div', async () => {
    textRunsRender.mockImplementation(async (_d, i) => ({ runs: i === 0 ? [run({}), run({ x: 80, start: 7, text: ' more' })] : [] }));
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span')).toHaveLength(2));
    expect(textRunsRender).toHaveBeenCalledTimes(1);
    expect(textRunsRender).toHaveBeenCalledWith(1, 0);
    const spans = [...document.querySelectorAll('.mv-blitz-text span')];
    expect(spans[0].dataset.node).toBe('5');
    expect(spans[1].dataset.start).toBe('7');
    expect(spans[1].style.left).toBe('10px'); // x 80 minus flow 70
    expect(spans[0].closest('[data-tile]').dataset.tile).toBe('0');
  });

  it('spans keep logical order and dir=auto (RTL)', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'שלום ', x: 200, start: 0 }), run({ text: 'abc', x: 100, start: 9 })] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span')).toHaveLength(2));
    const spans = [...document.querySelectorAll('.mv-blitz-text span')];
    expect(spans.map(s => s.textContent)).toEqual(['שלום ', 'abc']);
    expect(spans.every(s => s.getAttribute('dir') === 'auto')).toBe(true);
  });

  it('tile containers exist for every tile in order, so a late tile lands in reading order', async () => {
    textRunsRender.mockImplementation(async (_d, i) => ({ runs: [run({ node: 10 + i, y: i * 512, text: `t${i}` })] }));
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span')).toHaveLength(1));
    rerender(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0, 2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span')).toHaveLength(2));
    expect([...document.querySelectorAll('.mv-blitz-text span')].map(s => s.textContent)).toEqual(['t0', 't2']);
  });

  it('a <br> newline never reaches a span (it would break the flow line)', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'x\n', w: 20, start: 0 }), run({ text: 'y', x: 0, y: 30, w: 10, start: 2 })] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span')).toHaveLength(2));
    const [a, b] = document.querySelectorAll('.mv-blitz-text span');
    expect(a.textContent).toBe('x ');
    expect(b.textContent).not.toMatch(/\n/);
    expect(b.style.top).toBe('30px');
  });

  it('a late reply for an older rev is dropped', async () => {
    let resolveOld;
    textRunsRender.mockImplementationOnce(() => new Promise(r => { resolveOld = r; })).mockResolvedValue({ runs: [run({ text: 'new' })] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    rerender(<TextLayer docId={1} rev={2} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelector('.mv-blitz-text span')?.textContent).toBe('new'));
    await act(async () => { resolveOld({ runs: [run({ text: 'old' })] }); });
    expect([...document.querySelectorAll('.mv-blitz-text span')].map(s => s.textContent)).toEqual(['new']);
  });

  it('a new rev drops cached runs and refetches', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({})] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(textRunsRender).toHaveBeenCalledTimes(1));
    rerender(<TextLayer docId={1} rev={2} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(textRunsRender).toHaveBeenCalledTimes(2));
  });

  it('loadAll fetches every tile', async () => {
    textRunsRender.mockResolvedValue({ runs: [] });
    const ref = createRef();
    render(<TextLayer ref={ref} docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await act(async () => { await ref.current.loadAll(); });
    expect(textRunsRender.mock.calls.map(c => c[1]).sort()).toEqual([0, 1, 2]);
  });

  it('a failed runs fetch leaves that tile empty and is retried on the next rev, never thrown', async () => {
    textRunsRender.mockRejectedValueOnce(new Error('render_unavailable'));
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(textRunsRender).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('.mv-blitz-text span')).toHaveLength(0);
  });

  it('one root div per inline root, runs of a root keep logical order, hover flips the cursor flag', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ node: 5, text: 'a', w: 10, start: 0 }), run({ node: 5, text: 'b', x: 10, w: 10, start: 1 }), run({ node: 6, text: 'c', y: 40, w: 10, start: 0 })] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-root')).toHaveLength(2));
    const roots = [...document.querySelectorAll('.mv-blitz-root')];
    expect(roots[0].querySelectorAll('span')).toHaveLength(2);
    expect(roots[1].style.top).toBe('40px');
    expect(screen.getByTestId('blitz-text-layer').dataset.hover).toBeUndefined();
    rerender(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} hover />);
    expect(screen.getByTestId('blitz-text-layer').dataset.hover).toBe('true');
  });

  it('reports loaded runs and exposes first/last span', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'a', w: 10 }), run({ text: 'b', x: 10, w: 10, start: 1 })] });
    const ref = createRef();
    const onRunsLoaded = vi.fn();
    render(<TextLayer ref={ref} docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} onRunsLoaded={onRunsLoaded} />);
    await waitFor(() => expect(onRunsLoaded).toHaveBeenCalledWith(0, expect.any(Array)));
    expect(ref.current.firstSpan().textContent).toBe('a');
    expect(ref.current.lastSpan().textContent).toBe('b');
    expect(ref.current.layerEl().dataset.testid ?? ref.current.layerEl().getAttribute('data-testid')).toBe('blitz-text-layer');
  });
});
