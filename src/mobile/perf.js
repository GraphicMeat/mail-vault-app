// The in-app perf probe for the Plan 1 go/no-go gate (runs only with `?perf=1`).
//
// Scroll: the list's scroll element is moved a fixed SCROLL_PX_PER_FRAME on every
// requestAnimationFrame from the top to the bottom, and the gap between consecutive rAF
// timestamps is recorded only inside that window. A frame the webview takes longer to produce
// shows up as a longer gap; speed is per frame, not per second, so a slow frame does not make the
// next one jump further.
//
// Tap: TAP_COUNT rows spread from the first to the last are scrolled into view and clicked with a
// synthetic click. Each sample runs from just before the click is dispatched to the first paint
// of the viewer: the viewer reports from a message posted inside the rAF after its commit, which
// runs once that frame has been painted.
//
// `tapToPaint` is the slowest of those samples (`tapStat: "max"`): every tap must be under the
// limit. `tapP50` and `tapP95` ride along.
// Each click is dispatched right after a rAF, at the start of a frame, so the viewer's paint lands
// on the next vsync: a sample carries up to one extra frame over a real tap (conservative).
//
// `blankFrames` counts scroll frames in which any row was still a placeholder (page not loaded),
// since those frames are cheaper and would flatter frameP95.
//
// A pass also needs the run itself to be whole: at least PERF_ROWS rows, the scroll reached the
// bottom (`reachedEnd`), and no blank frame. Anything less is reported as a reason, never a pass.

import { ROW_HEIGHT } from './MessageRow.jsx';
import { FRAME_P95_LIMIT_MS, TAP_LIMIT_MS, PERF_ROWS, gateVerdict, wholeRunReasons } from './gate.js';

export { FRAME_P95_LIMIT_MS, TAP_LIMIT_MS, PERF_ROWS, gateVerdict, wholeRunReasons };
export const SCROLL_PX_PER_FRAME = 100;
export const TAP_COUNT = 20;

/** Nearest-rank percentile. An empty sample is Infinity, so it can never pass a gate. */
export function percentile(values, p) {
  if (!values || values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** Rows to tap: TAP_COUNT indices spread evenly from 0 to rows - 1. */
export function tapIndices(rows) {
  if (rows <= 0) return [];
  const n = Math.min(TAP_COUNT, rows);
  if (n === 1) return [0];
  return Array.from({ length: n }, (_, k) => Math.round((k * (rows - 1)) / (n - 1)));
}

// JSON has no Infinity: a missing measurement is reported as -1 and never passes.
const ms = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : -1);

export function summarizePerf({ frames, taps, rows, webview, blankFrames = 0, reachedEnd = false }) {
  const frameP95 = percentile(frames, 95);
  // Fewer taps than asked for means some never reached the viewer: not a measurement.
  const tapMax = taps.length ? Math.max(...taps) : Infinity;
  const tapToPaint = taps.length < TAP_COUNT ? Infinity : tapMax;
  const verdict = gateVerdict({ frameP95, tapToPaint });
  const reasons = [...verdict.reasons, ...wholeRunReasons({ rows, reachedEnd, blankFrames })];
  return {
    rows,
    frames: frames.length,
    reachedEnd,
    blankFrames,
    frameP50: ms(percentile(frames, 50)),
    frameP95: ms(frameP95),
    frameMax: ms(frames.length ? Math.max(...frames) : Infinity),
    taps: taps.length,
    tapStat: 'max',
    tapToPaint: ms(tapToPaint),
    tapP50: ms(percentile(taps, 50)),
    tapP95: ms(percentile(taps, 95)),
    scrollPxPerFrame: SCROLL_PX_PER_FRAME,
    rowHeight: ROW_HEIGHT,
    pass: reasons.length === 0,
    reasons,
    webview,
  };
}

// The viewer calls `viewerPainted()` after its first paint; a tap sample waits on it.
let paintWaiters = [];
export function viewerPainted(t) {
  const waiters = paintWaiters;
  paintWaiters = [];
  for (const resolve of waiters) resolve(t);
}
function nextViewerPaint() {
  return new Promise((resolve) => paintWaiters.push(resolve));
}

/** Calls `cb(now)` once the frame after the current commit has been painted. */
export function afterNextPaint(cb, now = () => performance.now()) {
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      cb(now());
    };
    ch.port2.postMessage(0);
  });
}

const frame = () => new Promise((r) => requestAnimationFrame(r));
async function frames(n) {
  for (let i = 0; i < n; i++) await frame();
}
async function waitFor(get, maxFrames) {
  for (let i = 0; i < maxFrames; i++) {
    const v = get();
    if (v) return v;
    await frame();
  }
  return null;
}
const withTimeout = (p, msLimit) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(null), msLimit))]);

const click = () => new MouseEvent('click', { bubbles: true, cancelable: true });

export async function scrollThrough(list) {
  const deltas = [];
  let blank = 0;
  let reachedEnd = false;
  list.scrollTop = 0;
  await frames(10);
  await new Promise((resolve) => {
    let last = null;
    let stuck = 0;
    const step = (ts) => {
      if (last !== null) deltas.push(ts - last);
      last = ts;
      // A placeholder row is cheaper to paint than a real one: count frames that showed any.
      if (list.querySelector('[data-loaded="0"]')) blank++;
      const max = list.scrollHeight - list.clientHeight;
      if (list.scrollTop >= max - 1) {
        reachedEnd = true;
        return resolve();
      }
      const before = list.scrollTop;
      list.scrollTop = Math.min(max, before + SCROLL_PX_PER_FRAME);
      // A scroller that will not move would loop forever; give up after a second of frames.
      stuck = list.scrollTop === before ? stuck + 1 : 0;
      if (stuck > 60) return resolve();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return { deltas, blank, reachedEnd };
}

async function tapRows(list, rows) {
  const samples = [];
  for (const i of tapIndices(rows)) {
    list.scrollTop = i * ROW_HEIGHT;
    const el = await waitFor(() => list.querySelector(`[data-index="${i}"][data-loaded="1"]`), 300);
    if (!el) continue;
    await frames(2);
    const painted = nextViewerPaint();
    const t0 = performance.now();
    el.dispatchEvent(click());
    const t1 = await withTimeout(painted, 2000);
    if (t1 != null) samples.push(t1 - t0);
    const close = await waitFor(() => document.querySelector('[data-mv-viewer-close]'), 60);
    close?.dispatchEvent(click());
    await frames(3);
  }
  return samples;
}

/** Runs the scroll and tap probes against the mounted list and returns the result object. */
export async function runPerfGate() {
  const list = await waitFor(() => document.querySelector('[data-mv-list]'), 600);
  if (!list) throw new Error('perf: list not mounted');
  const rows = Number(list.dataset.total) || 0;
  await frames(30);
  const scroll = await scrollThrough(list);
  await frames(10);
  const taps = await tapRows(list, rows);
  list.scrollTop = 0;
  await frames(5);
  return summarizePerf({
    frames: scroll.deltas, blankFrames: scroll.blank, reachedEnd: scroll.reachedEnd, taps, rows, webview: navigator.userAgent,
  });
}
