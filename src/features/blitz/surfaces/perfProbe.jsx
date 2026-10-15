import React from 'react';
import { createRoot } from 'react-dom/client';
import { buildEmailIframeHtml, attachEmailIframeAutoSize, getEmailBodyContent } from '../../../utils/emailIframeTemplate';
import Body from '../BlitzBody';
import { getDocRegistry } from './docRegistry';

// The thread and chat perf gate's probe (tests/e2e/connected-blitz-perf.test.js).
// E2E builds only: installPerfProbe is a no-op unless VITE_E2E === '1'.

function IframeBody({ html }) {
  const ref = React.useRef(null);
  React.useEffect(() => attachEmailIframeAutoSize(ref.current, { minHeight: 100 }), []);
  return <iframe ref={ref} data-perf-body srcDoc={buildEmailIframeHtml({ bodyHtml: getEmailBodyContent(html) })} style={{ width: '100%', minHeight: 100, border: 0, display: 'block' }} sandbox="allow-same-origin" title="perf" />;
}

const painted = (el) => {
  if (el.tagName === 'IFRAME') return el.contentDocument?.readyState === 'complete' && parseFloat(el.style.height) > 1;
  const t = el.querySelector('[data-testid="blitz-tile"]');
  return !!(t && t.complete && t.naturalWidth > 0);
};

const tick = () => new Promise((r) => setTimeout(r, 0));
let runCounter = 0;

/**
 * The deferred docs of the previous run would answer the next run's opens from the registry (an LRU of 8 for 60 s),
 * so the gate would time the pre-pass alone. Closed before and after every Blitz run (plan D F14).
 */
async function dropDeferred() {
  getDocRegistry().closeDeferred();
  await tick();
}

/**
 * Mounts `htmls` in a `width` x 900 scroll box and times it until every body in the box's viewport has painted.
 * Resolves { ms, longestGapMs, visible } plus, for Blitz, the registry evidence that every body was a fresh
 * render.open: `opens` (new doc ids this run created), `drawn` (bodies that ended with a doc) and `visibleDocs`.
 */
export async function runPerf({ htmls, width, mode, surface }) {
  const blitz = mode === 'blitz';
  const registry = getDocRegistry();
  if (blitz) await dropDeferred();
  const idsBefore = new Set(registry.docIds());
  const run = ++runCounter;
  const box = document.createElement('div');
  // data-blitz-scroll-root: the lazy open's IntersectionObserver root, as the thread and chat scrollers are.
  box.setAttribute('data-blitz-scroll-root', '');
  box.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:900px;overflow:auto;z-index:2147483647;background:#fff`;
  document.body.appendChild(box);
  const root = createRoot(box);
  let last = performance.now(); let longest = 0; let ticking = true;
  const ticker = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (ticking) setTimeout(ticker, 0); };
  setTimeout(ticker, 0);
  const t0 = performance.now();
  // Each body's html is unique to this run and index (a comment survives the pre-pass), so even a registry hit
  // across runs, or two corpus entries that are equal, cannot share a doc: every body is its own render.open.
  root.render(<div>{htmls.map((h, i) => (blitz
    ? <div key={i} data-perf-body style={{ width }}><Body surface={surface} messageKey={`perf-${run}-${i}`} bodyHtml={`${getEmailBodyContent(h)}<!--perf run ${run} body ${i}-->`} theme={{ dark: false, palette: 'graphite' }} sizing="content" style={{ minHeight: 100 }} /></div>
    : <IframeBody key={i} html={h} />))}</div>);
  const visibleBodies = () => [...box.querySelectorAll('[data-perf-body]')].filter((el) => { const r = el.getBoundingClientRect(); const b = box.getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom; });
  try {
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 20_000;
      const poll = () => {
        const vis = visibleBodies();
        if (vis.length && vis.every(painted)) return resolve();
        if (performance.now() > deadline) return reject(new Error('perf: never painted'));
        requestAnimationFrame(poll);
      };
      poll();
    });
  } catch (e) {
    ticking = false; root.unmount(); box.remove();
    if (blitz) await dropDeferred();
    throw e;
  }
  const ms = Math.round(performance.now() - t0);
  ticking = false;
  const visible = visibleBodies().length;
  const out = { ms, longestGapMs: Math.round(longest), visible };
  if (blitz) {
    // Untimed: let the near-but-not-visible bodies finish opening so `drawn` and `opens` can be compared.
    const settleBy = performance.now() + 15_000;
    while (registry.pendingCount() > 0 && performance.now() < settleBy) await tick();
    out.opens = registry.docIds().filter((id) => !idsBefore.has(id)).length;
    out.drawn = box.querySelectorAll('[data-perf-body] [data-blitz-doc]').length;
    out.visibleDocs = visibleBodies().filter((el) => el.querySelector('[data-blitz-doc]')).length;
  }
  root.unmount();
  box.remove();
  if (blitz) await dropDeferred();
  return out;
}

export function installPerfProbe(win = typeof window !== 'undefined' ? window : null) {
  if (import.meta.env.VITE_E2E !== '1' || !win) return;
  win.__MV_BLITZ_PERF__ = { run: runPerf };
}
