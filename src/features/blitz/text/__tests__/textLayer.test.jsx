// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import React, { createRef } from 'react';
import { readFileSync } from 'node:fs';
vi.mock('../../service', () => ({ textRunsRender: vi.fn() }));
import { textRunsRender } from '../../service';
import TextLayer, { groupSegments, stackLines } from '../TextLayer';
import { layerPlainText } from '../selection';
import { utf8Length, utf16ToUtf8, graphemeCount, fitRun, createMeasure } from '../textMetrics';

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

describe('textMetrics fixes', () => {
  it('fitRun gives letter-spacing 0 when a non-empty text measures 0', () => {
    expect(fitRun(run({ text: 'abc', w: 50 }), () => 0).letterSpacing).toBe(0);
  });
  it('createMeasure falls back to a DOM canvas when OffscreenCanvas has no 2d context, and sets the font only on change', () => {
    const fonts = [];
    const ctx = { set font(v) { fonts.push(v); }, get font() { return fonts[fonts.length - 1] ?? ''; }, measureText: (t) => ({ width: t.length * 5 }) };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    globalThis.OffscreenCanvas = class { getContext() { return null; } };
    try {
      const m = createMeasure('serif');
      expect(m('abcd', 10)).toBe(20);
      expect(m('ab', 10)).toBe(10);
      expect(m('abcd', 12)).toBe(20);
      expect(fonts).toEqual(['10px serif', '12px serif']);
    } finally { delete globalThis.OffscreenCanvas; spy.mockRestore(); }
  });
  it('createMeasure remembers a definitive no-context and returns 0', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    try {
      const m = createMeasure('serif');
      expect(m('abc', 10)).toBe(0);
      expect(m('abd', 10)).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});

describe('blitz.css', () => {
  const css = readFileSync('src/features/blitz/blitz.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('the layer sets no cursor of its own, so the box cursor shows through; hover makes the layer and spans pointers', () => {
    const layer = css.match(/\.mv-blitz-text\s*\{([^}]*)\}/)[1];
    expect(layer).not.toMatch(/cursor/);
    expect(css).toMatch(/\.mv-blitz-text\[data-hover="true"\],\s*\.mv-blitz-text\[data-hover="true"\] span\s*\{\s*cursor:\s*pointer/);
  });
  it('a root wraps only at its <wbr>s with no strut, and span stacking stays inside the layer', () => {
    const layer = css.match(/\.mv-blitz-text\s*\{([^}]*)\}/)[1];
    expect(layer).toContain('isolation: isolate');
    const root = css.match(/\.mv-blitz-text \.mv-blitz-root\s*\{([^}]*)\}/)[1];
    expect(root).toContain('white-space: normal');
    expect(root).toContain('line-height: 0');
    const text = css.match(/\.mv-blitz-text span\[data-node\]\s*\{([^}]*)\}/)[1];
    expect(text).toContain('position: relative');
    expect(text).toContain('z-index: 1');
  });
  it('pins the properties the flow math assumes', () => {
    const layer = css.match(/\.mv-blitz-text\s*\{([^}]*)\}/)[1];
    for (const d of ['direction: ltr', 'text-align: left', 'text-indent: 0', 'word-spacing: normal', 'text-transform: none', 'font-weight: normal', 'font-style: normal']) expect(layer).toContain(d);
  });
});

describe('segments and line boxes', () => {
  it('groupSegments takes the box of a root with more runs than an engine allows call arguments', () => {
    for (const n of [70_000, 1_000_000]) {
      const runs = Array.from({ length: n }, (_, i) => ({ x: i % 7, y: i * 2, w: 5, h: 2, text: 'a', fontPx: 10, node: 1, start: i }));
      let groups;
      expect(() => { groups = groupSegments(runs); }).not.toThrow();
      expect(groups).toHaveLength(1);
      expect([groups[0].left, groups[0].top, groups[0].right, groups[0].bottom]).toEqual([0, 0, 11, n * 2]);
    }
  });

  it('groupSegments splits one root at its segments, in order', () => {
    const groups = groupSegments([run({ start: 0, seg: 0 }), run({ start: 4, seg: 4, y: 30 }), run({ start: 9, seg: 4, y: 60 }), run({ node: 6, start: 0, seg: 0, y: 90 })]);
    expect(groups.map(g => [g.node, g.seg, g.runs.length])).toEqual([[5, 0, 1], [5, 4, 2], [6, 0, 1]]);
  });

  it('stackLines: whole-px line boxes whose tops never drift down a tall block, the shift keeps the exact y', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ y: 100 + i * 18.4, h: 18.4 }));
    const boxes = stackLines(lines, 100);
    let flow = 0;
    boxes.forEach((b, i) => {
      expect(Number.isInteger(b.height)).toBe(true);
      expect(Math.abs(flow - i * 18.4)).toBeLessThanOrEqual(0.5);
      expect(flow + b.shift).toBeCloseTo(i * 18.4, 6);
      expect(b.gap).toBe(0);
      flow += b.height + b.gap;
    });
    expect(flow).toBe(Math.round(60 * 18.4));
  });

  // Parley's shape: it advances the line top by the unrounded line height but
  // rounds each top and each box (in device px, then divides by the scale), so
  // a box is round(LH) tall on an LH pitch and every other box overlaps the
  // next line when LH has a fraction >= .5 in device px.
  for (const [name, lh, dpr] of [['22.5 px at dpr 1', 22.5, 1], ['19.5 px at dpr 1', 19.5, 1], ['18.4 px at dpr 2', 18.4, 2], ['20.7 px at dpr 1.5', 20.7, 1.5]]) {
    it(`stackLines: parley-shaped overlapping boxes (${name}) never drift down 87 lines`, () => {
      const dev = lh * dpr;
      const lines = Array.from({ length: 87 }, (_, k) => ({ y: 40 + Math.round(k * dev) / dpr, h: Math.round(dev) / dpr }));
      const boxes = stackLines(lines, 40);
      let flow = 0;
      boxes.forEach((b, k) => {
        const at = lines[k].y - 40;
        expect(Math.abs(flow - Math.round(at))).toBeLessThanOrEqual(0.5);
        expect(Math.abs(b.shift)).toBeLessThanOrEqual(0.5);
        expect(Number.isInteger(b.height) && Number.isInteger(b.gap) && b.height >= 0 && b.gap >= 0).toBe(true);
        flow += b.height + b.gap;
      });
    });
  }

  it('stackLines: a dropped line is a whole-px gap and the next box still lands on its line', () => {
    const boxes = stackLines([{ y: 0, h: 18.4 }, { y: 36.8, h: 18.4 }], 0);
    expect(boxes[0]).toEqual({ shift: 0, height: 18, gap: 19 });
    expect(boxes[1].shift).toBeCloseTo(36.8 - 37, 6);
  });
});

describe('TextLayer', () => {
  it('fetches runs for shown tiles only and renders one span per run in a root div', async () => {
    textRunsRender.mockImplementation(async (_d, i) => ({ runs: i === 0 ? [run({}), run({ x: 80, start: 7, text: ' more' })] : [] }));
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(2));
    expect(textRunsRender).toHaveBeenCalledTimes(1);
    expect(textRunsRender).toHaveBeenCalledWith(1, 0);
    const spans = [...document.querySelectorAll('.mv-blitz-text span[data-node]')];
    expect(spans[0].dataset.node).toBe('5');
    expect(spans[1].dataset.start).toBe('7');
    expect(spans[1].style.marginLeft).toBe('10px'); // x 80 minus flow 70
    expect(spans[0].closest('[data-tile]').dataset.tile).toBe('0');
  });

  it('spans keep logical order and dir=auto (RTL)', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'שלום ', x: 200, start: 0 }), run({ text: 'abc', x: 100, start: 9 })] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(2));
    const spans = [...document.querySelectorAll('.mv-blitz-text span[data-node]')];
    expect(spans.map(s => s.textContent)).toEqual(['שלום ', 'abc']);
    expect(spans.every(s => s.getAttribute('dir') === 'auto')).toBe(true);
  });

  it('tile containers exist for every tile in order, so a late tile lands in reading order', async () => {
    textRunsRender.mockImplementation(async (_d, i) => ({ runs: [run({ node: 10 + i, y: i * 512, text: `t${i}` })] }));
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(1));
    rerender(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0, 2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(2));
    expect([...document.querySelectorAll('.mv-blitz-text span[data-node]')].map(s => s.textContent)).toEqual(['t0', 't2']);
  });

  it('a <br> newline never reaches a span: the next line is a line box of its own, not a newline', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'x\n', w: 20, start: 0 }), run({ text: 'y', x: 0, y: 30, w: 10, start: 2 })] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(2));
    const [a, b] = document.querySelectorAll('.mv-blitz-text span[data-node]');
    expect(a.textContent).toBe('x ');
    expect(b.textContent).not.toMatch(/\n/);
    expect(b.closest('.mv-blitz-line')).not.toBe(a.closest('.mv-blitz-line'));
    expect(b.style.top).toBe('0px'); // the line box is already at 30
  });

  it('a root is one block whose visual lines are soft-wrapped line wrappers: no <br>, no newline, one <wbr> between lines', async () => {
    textRunsRender.mockResolvedValue({ runs: [
      run({ text: 'aaaa ', x: 10, w: 50, start: 0 }),
      run({ text: 'bbbb ', x: 60, w: 50, start: 5, fontPx: 24 }),
      run({ text: 'cccc', x: 10, y: 30, w: 40, start: 10 }),
    ] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(3));
    const roots = document.querySelectorAll('.mv-blitz-root');
    expect(roots).toHaveLength(1);
    const root = roots[0];
    const lines = [...root.querySelectorAll('.mv-blitz-line')];
    expect(lines.map(l => l.querySelectorAll('span[data-node]').length)).toEqual([2, 1]);
    expect(root.querySelector('br')).toBeNull();
    expect(root.querySelectorAll('wbr')).toHaveLength(1);
    expect(root.textContent).toBe('aaaa bbbb cccc');
    // 0 px wide: it wraps at every <wbr>; its hit area is padding out to the layer's edge.
    expect(root.style.width).toBe('0px');
    expect(root.style.left).toBe('10px');
    expect(root.style.paddingRight).toBe('590px');
    // The flow offset restarts on each line.
    expect(lines[0].querySelectorAll('span[data-node]')[1].style.marginLeft).toBe('0px');
    expect(lines[1].querySelector('span[data-node]').style.marginLeft).toBe('0px');
  });

  it('lines the worker left out become a gap box of their height, so the next line box sits at its drawn top', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'one ', start: 0 }), run({ text: 'three', y: 60, start: 9 })] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(2));
    const gaps = document.querySelectorAll('.mv-blitz-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].style.height).toBe('30px');
    expect(gaps[0].getAttribute('aria-hidden')).toBe('true');
    expect(gaps[0].dataset.node).toBeUndefined();
    expect(document.querySelectorAll('.mv-blitz-text span[data-node]')[1].style.top).toBe('0px');
  });

  it("a root's hit area stops at the next root on its right that shares its height", async () => {
    textRunsRender.mockResolvedValue({ runs: [
      run({ node: 5, text: 'left', x: 0, w: 50, start: 0 }),
      run({ node: 6, text: 'right', x: 300, w: 50, start: 0 }),
      run({ node: 7, text: 'below', x: 0, y: 100, w: 50, start: 0 }),
    ] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-root')).toHaveLength(3));
    const pad = [...document.querySelectorAll('.mv-blitz-root')].map(r => r.style.paddingRight);
    expect(pad).toEqual(['300px', '300px', '600px']);
  });

  it('a paragraph is fetched with the tile of its first line: a shown tile loads the owner tiles it names', async () => {
    textRunsRender.mockImplementation(async (_d, i) => (i === 2 ? { runs: [], owners: [0] } : { runs: [run({ text: `t${i}` })] }));
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(1));
    expect(textRunsRender.mock.calls.map(c => c[1]).sort()).toEqual([0, 2]);
    expect(document.querySelector('[data-tile="0"] span[data-node]').textContent).toBe('t0');
  });

  it('a new rev asks again for every tile it holds, not only the shown ones: a root that moved tile is never drawn twice', async () => {
    let rev = 1;
    // Rev 1: the paragraph's first line is in tile 1, which only tile 2's owners name. Rev 2: it moved to tile 2.
    textRunsRender.mockImplementation(async (_d, i) => {
      if (i === 1) return { runs: rev === 1 ? [run({ node: 9, y: 500, text: 'para' })] : [] };
      if (i === 2) return rev === 1 ? { runs: [], owners: [1] } : { runs: [run({ node: 9, y: 520, text: 'para' })] };
      return { runs: [] };
    });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('span[data-node="9"]')).toHaveLength(1));
    rev = 2;
    rerender(<TextLayer docId={1} rev={2} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelector('[data-tile="2"] span[data-node="9"]')).not.toBeNull());
    await waitFor(() => expect(textRunsRender.mock.calls.filter(c => c[1] === 1)).toHaveLength(2));
    await waitFor(() => expect(document.querySelectorAll('span[data-node="9"]')).toHaveLength(1));
  });

  it('each hard-broken segment of a root is its own block; offsets and node stay the root\'s', async () => {
    textRunsRender.mockResolvedValue({ runs: [
      run({ text: 'one\n', w: 30, start: 0, seg: 0 }),
      run({ text: 'two\n', w: 30, y: 30, start: 4, seg: 4 }),
      run({ text: 'three', w: 50, y: 60, start: 8, seg: 8 }),
    ] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-root')).toHaveLength(3));
    const roots = [...document.querySelectorAll('.mv-blitz-root')];
    expect(roots.map(r => r.style.top)).toEqual(['0px', '30px', '60px']);
    expect(roots.map(r => r.querySelectorAll('.mv-blitz-line').length)).toEqual([1, 1, 1]);
    const spans = [...document.querySelectorAll('span[data-node]')];
    expect(spans.map(x => [x.dataset.node, x.dataset.start])).toEqual([['5', '0'], ['5', '4'], ['5', '8']]);
  });

  it('a hard newline drawn as a space stays in the selected layer text (the copy and reply floor)', async () => {
    textRunsRender.mockResolvedValue({ runs: [
      run({ text: 'Brline one\n', w: 110, start: 0, seg: 0 }),
      run({ text: 'Brline two\n', w: 110, y: 30, start: 11, seg: 11 }),
      run({ text: 'Brline three', w: 120, y: 60, start: 22, seg: 22 }),
    ] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('span[data-node]')).toHaveLength(3));
    const spans = [...document.querySelectorAll('span[data-node]')];
    expect(spans.map(s => s.textContent)).toEqual(['Brline one ', 'Brline two ', 'Brline three']);
    const r = document.createRange(); r.setStart(spans[0].firstChild, 0); r.setEnd(spans[2].firstChild, 12);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    expect(layerPlainText(window.getSelection(), document.querySelector('.mv-blitz-text'))).toBe('Brline one\nBrline two\nBrline three');
    window.getSelection().removeAllRanges();
  });

  it('owners are followed one step from a shown tile, not chained through owner tiles', async () => {
    textRunsRender.mockImplementation(async (_d, i) => (i === 2 ? { runs: [], owners: [1] } : i === 1 ? { runs: [run({ text: 'mid' })], owners: [0] } : { runs: [] }));
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('span[data-node]')).toHaveLength(1));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(textRunsRender.mock.calls.map(c => c[1])).toEqual([2, 1]);
  });

  it('a refetch that brings the same runs keeps the tile as it is: no refit', async () => {
    textRunsRender.mockImplementation(async () => ({ runs: [run({ text: 'same', w: 40 })] }));
    const m = vi.fn(measure);
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={m} />);
    await waitFor(() => expect(document.querySelectorAll('span[data-node]')).toHaveLength(1));
    const calls = m.mock.calls.length;
    rerender(<TextLayer docId={1} rev={2} meta={meta} shownTiles={new Set([0])} measure={m} />);
    await waitFor(() => expect(textRunsRender).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(m.mock.calls.length).toBe(calls);
  });

  it('a late reply for an older rev is dropped', async () => {
    let resolveOld;
    textRunsRender.mockImplementationOnce(() => new Promise(r => { resolveOld = r; })).mockResolvedValue({ runs: [run({ text: 'new' })] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    rerender(<TextLayer docId={1} rev={2} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelector('.mv-blitz-text span[data-node]')?.textContent).toBe('new'));
    await act(async () => { resolveOld({ runs: [run({ text: 'old' })] }); });
    expect([...document.querySelectorAll('.mv-blitz-text span[data-node]')].map(s => s.textContent)).toEqual(['new']);
  });

  it('runs of tiles past a smaller tileCount are dropped: they never resurface when the count grows again', async () => {
    let tile2Calls = 0;
    textRunsRender.mockImplementation((_d, i) => {
      if (i !== 2) return Promise.resolve({ runs: [] });
      tile2Calls++;
      return tile2Calls === 1 ? Promise.resolve({ runs: [run({ node: 12, text: 'stale' })] }) : new Promise(() => {});
    });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([2])} measure={measure} />);
    await waitFor(() => expect(document.querySelector('[data-tile="2"] span[data-node="12"]')).not.toBeNull());
    rerender(<TextLayer docId={1} rev={2} meta={{ ...meta, tileCount: 1 }} shownTiles={new Set([0])} measure={measure} />);
    expect(document.querySelector('[data-tile="2"]')).toBeNull();
    rerender(<TextLayer docId={1} rev={3} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    expect(document.querySelector('[data-tile="2"]')).not.toBeNull(); // the container is back, empty
    expect(document.querySelector('[data-tile="2"] span[data-node]')).toBeNull();
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

  it('a failed runs fetch leaves that tile empty and never throws', async () => {
    textRunsRender.mockRejectedValueOnce(new Error('render_unavailable'));
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(textRunsRender).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(0);
  });

  it('one root div per inline root, runs of a root keep logical order, hover flips the cursor flag', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ node: 5, text: 'a', w: 10, start: 0 }), run({ node: 5, text: 'b', x: 10, w: 10, start: 1 }), run({ node: 6, text: 'c', y: 40, w: 10, start: 0 })] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-root')).toHaveLength(2));
    const roots = [...document.querySelectorAll('.mv-blitz-root')];
    expect(roots[0].querySelectorAll('span[data-node]')).toHaveLength(2);
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

  it('a tab is drawn as a space so the flow width stays the measured width', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'a\tb', w: 15 })] });
    render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(1));
    expect(document.querySelector('.mv-blitz-text span[data-node]').textContent).toBe('a b');
  });

  it('a rev change keeps the live span nodes until the new reply replaces them', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'same', w: 40 })] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(1));
    const before = document.querySelector('.mv-blitz-text span[data-node]');
    let resolve2;
    textRunsRender.mockImplementationOnce(() => new Promise(r => { resolve2 = r; }));
    rerender(<TextLayer docId={1} rev={2} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(textRunsRender).toHaveBeenCalledTimes(2));
    expect(document.querySelector('.mv-blitz-text span[data-node]')).toBe(before); // not blanked while rev 2 is in flight
    await act(async () => { resolve2({ runs: [run({ text: 'same', w: 40, x: 5 })] }); });
    expect(document.querySelector('.mv-blitz-text span[data-node]')).toBe(before); // same node, restyled
    expect(before.style.marginLeft).toBe('0px');
  });

  it('a docId change clears every tile at once', async () => {
    textRunsRender.mockResolvedValueOnce({ runs: [run({ text: 'old' })] });
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(1));
    textRunsRender.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<TextLayer docId={2} rev={1} meta={meta} shownTiles={new Set([0])} measure={measure} />);
    expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(0);
  });

  it('a hover or shown-set change does not refit spans of loaded tiles', async () => {
    textRunsRender.mockResolvedValue({ runs: [run({ text: 'abc', w: 20 })] });
    const m = vi.fn(measure);
    const { rerender } = render(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={m} />);
    await waitFor(() => expect(document.querySelectorAll('.mv-blitz-text span[data-node]')).toHaveLength(1));
    const calls = m.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    rerender(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={m} hover />);
    rerender(<TextLayer docId={1} rev={1} meta={meta} shownTiles={new Set([0])} measure={m} />);
    expect(m.mock.calls.length).toBe(calls);
  });
});
