// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  percentile, gateVerdict, summarizePerf, scrollThrough, tapIndices,
  SCROLL_PX_PER_FRAME, TAP_COUNT, PERF_ROWS,
} from '../perf.js';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('percentile', () => {
  it('nearest rank: p95 of 1..100 is 95', () => {
    expect(percentile(range(100), 95)).toBe(95);
    expect(percentile(range(100), 50)).toBe(50);
    expect(percentile(range(100), 100)).toBe(100);
  });

  it('does not depend on input order and does not mutate it', () => {
    const v = range(100).reverse();
    expect(percentile(v, 95)).toBe(95);
    expect(v[0]).toBe(100);
  });

  it('empty input is Infinity so an empty run cannot pass', () => {
    expect(percentile([], 95)).toBe(Infinity);
    expect(gateVerdict({ frameP95: percentile([], 95), tapToPaint: 10 }).pass).toBe(false);
  });
});

describe('gateVerdict', () => {
  it('passes strictly under both thresholds', () => {
    expect(gateVerdict({ frameP95: 19.9, tapToPaint: 99 })).toEqual({ pass: true, reasons: [] });
  });

  it('frame p95 of exactly 20 fails and names the frame', () => {
    const v = gateVerdict({ frameP95: 20, tapToPaint: 99 });
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatch(/frame/i);
  });

  it('tap of exactly 100 fails and names the tap', () => {
    const v = gateVerdict({ frameP95: 19, tapToPaint: 100 });
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatch(/tap/i);
  });

  it('a missing or NaN number fails', () => {
    expect(gateVerdict({ frameP95: NaN, tapToPaint: 1 }).pass).toBe(false);
    expect(gateVerdict({ frameP95: 1 }).pass).toBe(false);
  });
});

const whole = { frames: Array(200).fill(16.7), rows: PERF_ROWS, webview: 'UA', blankFrames: 0, reachedEnd: true };
const fastTaps = range(20).map((n) => n * 4); // 4..80

describe('summarizePerf', () => {
  it('a whole fast run passes; tapToPaint is the slowest tap (Ruling 8)', () => {
    const r = summarizePerf({ ...whole, taps: fastTaps });
    expect(r).toMatchObject({
      rows: 10000, webview: 'UA', frames: 200, frameP95: 16.7, frameMax: 16.7, reachedEnd: true, blankFrames: 0,
      taps: 20, tapStat: 'max', tapToPaint: 80, tapP50: 40, tapP95: 76, scrollPxPerFrame: SCROLL_PX_PER_FRAME,
      pass: true, reasons: [],
    });
  });

  it('one slow tap fails the gate even when p95 is fast', () => {
    const taps = [...range(19).map(() => 10), 100];
    const r = summarizePerf({ ...whole, taps });
    expect(r.tapP95).toBe(10);
    expect(r.tapToPaint).toBe(100);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/tap/i);
  });

  it('a stalled scroll (reachedEnd false) fails', () => {
    const r = summarizePerf({ ...whole, taps: fastTaps, reachedEnd: false });
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(['the scroll did not reach the last row']);
  });

  it('a frame showing unloaded rows fails', () => {
    const r = summarizePerf({ ...whole, taps: fastTaps, blankFrames: 1 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/unloaded/);
  });

  it('fewer than 10,000 rows fails', () => {
    const r = summarizePerf({ ...whole, taps: fastTaps, rows: 250 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/250 rows/);
  });

  it('no frames or no taps cannot pass', () => {
    const r = summarizePerf({ frames: [], taps: [], rows: 0, webview: 'UA' });
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBe(4); // frame, tap, rows, reachedEnd (defaults false)
    expect(JSON.stringify(r)).not.toContain('null');
  });

  it('fewer taps than asked for fails even when fast', () => {
    const r = summarizePerf({ ...whole, taps: [5, 5] });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/tap/i);
  });

  it('PERF_ROWS matches the engine seed', () => {
    const seedRs = readFileSync(resolve(process.cwd(), 'src-mobile-engine/src/seed.rs'), 'utf8');
    expect(PERF_ROWS).toBe(10000);
    expect(seedRs).toContain('pub const PERF_ROWS: usize = 10_000;');
  });
});

describe('scrollThrough', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubRaf() {
    let ts = 0;
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb((ts += 16)), 0));
  }
  function fakeList({ max, moves = true, blankAt = -1 }) {
    let top = 0;
    return {
      clientHeight: 100,
      scrollHeight: max + 100,
      get scrollTop() { return top; },
      set scrollTop(v) { if (moves || v === 0) top = v; },
      querySelector: () => (blankAt >= 0 && top === blankAt ? {} : null),
    };
  }

  it('reaches the end at the fixed speed and counts blank frames', async () => {
    stubRaf();
    const r = await scrollThrough(fakeList({ max: 1000, blankAt: 300 }));
    expect(r.reachedEnd).toBe(true);
    expect(r.deltas.length).toBe(Math.ceil(1000 / SCROLL_PX_PER_FRAME));
    expect(r.deltas.every((d) => d === 16)).toBe(true);
    expect(r.blank).toBe(1);
  });

  it('a scroller that will not move gives up with reachedEnd false', async () => {
    stubRaf();
    const r = await scrollThrough(fakeList({ max: 1000, moves: false }));
    expect(r.reachedEnd).toBe(false);
    expect(r.deltas.length).toBe(60); // gives up on the 61st unmoved frame
  });
});

describe('tapIndices', () => {
  it('spreads 20 taps from the first row to the last', () => {
    const idx = tapIndices(10000);
    expect(TAP_COUNT).toBe(20);
    expect(idx).toHaveLength(20);
    expect(idx[0]).toBe(0);
    expect(idx[19]).toBe(9999);
    expect(new Set(idx).size).toBe(20);
  });
});
