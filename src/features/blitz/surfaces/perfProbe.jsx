import React from 'react';
import { createRoot } from 'react-dom/client';
import { buildEmailIframeHtml, attachEmailIframeAutoSize, getEmailBodyContent, emailScriptNonce } from '../../../utils/emailIframeTemplate';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../../../utils/iframeQuoteFolding';
import { buildChatBubbleDocument } from '../../../components/ChatBubbleView';
import Body from '../BlitzBody';
import { hitRender } from '../service';
import { getDocRegistry } from './docRegistry';

// The thread and chat perf gate's probe (tests/e2e/connected-blitz-perf.test.js).
// E2E builds only: installPerfProbe is a no-op unless VITE_E2E === '1'.

// The frame as the real surfaces mount it (same sandbox, same auto-size, minHeight 100). `onLoad` does not fire for the
// initial about:blank document, so `data-perf-loaded` is set only once the srcdoc document itself has loaded.
function IframeBody({ doc }) {
  const ref = React.useRef(null);
  React.useEffect(() => attachEmailIframeAutoSize(ref.current, { minHeight: 100 }), []);
  return (
    <iframe
      ref={ref} data-perf-body srcDoc={doc} title="perf" sandbox="allow-same-origin allow-popups allow-scripts"
      onLoad={(e) => { e.currentTarget.dataset.perfLoaded = '1'; }}
      style={{ width: '100%', minHeight: 100, border: 0, display: 'block' }}
    />
  );
}

const srcdocLoaded = (el) => {
  try { return el.contentWindow?.location.href === 'about:srcdoc' && !!el.contentDocument?.body?.firstChild; } catch { return false; }
};

export const painted = (el) => {
  if (el.tagName === 'IFRAME') {
    return el.dataset.perfLoaded === '1' && srcdocLoaded(el) && el.contentDocument?.readyState === 'complete' && parseFloat(el.style.height) > 1;
  }
  const t = el.querySelector('[data-testid="blitz-tile"]');
  return !!(t && t.complete && t.naturalWidth > 0);
};

const tick = () => new Promise((r) => setTimeout(r, 0));
let runCounter = 0;

/**
 * The deferred docs of the previous run would answer the next run's opens from the registry (an LRU of 8 for 60 s),
 * so the gate would time the pre-pass alone. Closed before and after every Blitz run (plan D F14), and the closes
 * awaited: a doc the worker still holds would load the next run's worker. The registry's close is fire-and-forget,
 * so the closes are observed through the worker: a hit on a closed doc rejects.
 */
async function dropDeferred() {
  const registry = getDocRegistry();
  const before = registry.docIds();
  registry.closeDeferred();
  await tick();
  const live = new Set(registry.docIds());
  const gone = before.filter((id) => !live.has(id));
  await Promise.all(gone.map(async (id) => {
    for (let i = 0; i < 100; i++) {
      try { await hitRender(id, 0, 0); } catch { return; }
      await tick();
    }
  }));
  const until = performance.now() + 5000;
  while (registry.pendingCount() > 0 && performance.now() < until) await tick();
}

// Each surface's body as the real surface hands it over: the thread's iframe template with the fold scripts
// (ThreadView) and Blitz's bodyHtml; the chat's bubble document (ChatBubbleView) for both. Built before the clock starts,
// as the surfaces build theirs in a memo.
const SIGNATURE = 'smart';
export function buildBodies(htmls, surface) {
  return htmls.map((h) => {
    const bodyHtml = getEmailBodyContent(h);
    const nonce = emailScriptNonce();
    if (surface === 'bubble') {
      return { bodyHtml, iframeDoc: buildChatBubbleDocument({ bodyHtml, fromUser: false, theme: 'light', palette: 'graphite', indicatorStyle: '', privacy: false, signatureDisplay: SIGNATURE, nonce }) };
    }
    return {
      bodyHtml,
      iframeDoc: buildEmailIframeHtml({ bodyHtml, themeTag: 'light', extraBody: `${getQuoteFoldingScript(nonce)}${getSignatureFoldingScript(SIGNATURE, nonce)}`, nonce }),
    };
  });
}

// The Blitz body's props for one built body, its html unique to this run and index (a comment survives the pre-pass).
export function blitzProps(surface, body, run, i) {
  const stamp = `<!--perf run ${run} body ${i}-->`;
  const common = { surface, messageKey: `perf-${run}-${i}`, theme: { dark: false, palette: 'graphite' }, signatureDisplay: SIGNATURE, foldQuotes: true };
  if (surface === 'bubble') {
    const end = body.iframeDoc.lastIndexOf('</body>');
    return { ...common, documentHtml: end < 0 ? body.iframeDoc + stamp : body.iframeDoc.slice(0, end) + stamp + body.iframeDoc.slice(end), sizing: { collapsedMax: 400 } };
  }
  return { ...common, bodyHtml: body.bodyHtml + stamp, sizing: 'content', style: { minHeight: 100 } };
}

/**
 * Mounts `htmls` in a `width` x 900 scroll box and times it until every body in the box's viewport has painted.
 * Resolves { ms, longestGapMs, visible } plus, for Blitz, the registry evidence that every body was a fresh
 * render.open: `opens` (new doc ids this run created), `drawn` (bodies that ended with a doc) and `visibleDocs`.
 */
export async function runPerf({ htmls: all, width, mode, surface, limit = null }) {
  // `limit`: mount only the first N bodies (the diagnostic control, not the gate).
  const htmls = limit ? all.slice(0, limit) : all;
  const blitz = mode === 'blitz';
  const registry = getDocRegistry();
  if (blitz) await dropDeferred();
  const idsBefore = new Set(registry.docIds());
  const run = ++runCounter;
  const bodies = buildBodies(htmls, surface);
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
  root.render(<div>{bodies.map((b, i) => (blitz
    ? <div key={i} data-perf-body style={{ width }}><Body {...blitzProps(surface, b, run, i)} /></div>
    : <IframeBody key={i} doc={b.iframeDoc} />))}</div>);
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
