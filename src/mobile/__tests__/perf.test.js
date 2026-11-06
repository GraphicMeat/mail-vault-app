// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { percentile, gateVerdict, summarizePerf, SCROLL_PX_PER_FRAME, TAP_COUNT, tapIndices } from '../perf.js';

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

describe('summarizePerf', () => {
  it('reports p95 of the taps as tapToPaint, with the fixed speed and the webview', () => {
    const frames = Array(200).fill(16.7);
    const taps = range(20).map((n) => n * 4); // 4..80
    const r = summarizePerf({ frames, taps, rows: 10000, webview: 'UA', blankFrames: 3 });
    expect(r.rows).toBe(10000);
    expect(r.blankFrames).toBe(3);
    expect(r.webview).toBe('UA');
    expect(r.frameP95).toBe(16.7);
    expect(r.frameMax).toBe(16.7);
    expect(r.frames).toBe(200);
    expect(r.tapStat).toBe('p95');
    expect(r.tapToPaint).toBe(76);
    expect(r.tapP50).toBe(40);
    expect(r.tapMax).toBe(80);
    expect(r.taps).toBe(20);
    expect(r.scrollPxPerFrame).toBe(SCROLL_PX_PER_FRAME);
    expect(r.pass).toBe(true);
  });

  it('no frames or no taps cannot pass', () => {
    const r = summarizePerf({ frames: [], taps: [], rows: 0, webview: 'UA' });
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBe(2);
    expect(JSON.stringify(r)).not.toContain('null');
  });

  it('fewer taps than asked for fails even when fast', () => {
    const r = summarizePerf({ frames: Array(100).fill(10), taps: [5, 5], rows: 10000, webview: 'UA' });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/tap/i);
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
