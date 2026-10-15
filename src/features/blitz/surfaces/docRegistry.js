import { openRender, closeRender, onRenderUpdated } from '../service';

// 53-bit FNV-1a over the html, so a key never holds a 4 MB string twice.
function hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return `${(h2 & 0x1fffff).toString(36)}${h1.toString(36)}`;
}

/** Everything that makes one worker doc differ from another. */
export function docKey({ html, cssWidth, scale, allowRemote, theme }) {
  return `${hash(html || '')}:${(html || '').length}|${cssWidth}|${scale}|${allowRemote ? 1 : 0}|${JSON.stringify(theme ?? null)}`;
}

/**
 * Open docs, shared by key and refcounted. A doc nobody holds is not closed at
 * once: it waits in a small LRU (`deferredMax`) for `deferredTtlMs`, so a
 * collapse-and-expand or a scroll back reuses it instead of re-rendering. A
 * doc released before its open lands is kept the same way, never leaked.
 * `release(key, { now: true })` closes instead of deferring (surfaces that are
 * not in LAZY_SURFACES). `close` may return a promise; closeAll awaits them.
 */
export function createDocRegistry({
  open, close, onUpdated = null, deferredMax = 8, deferredTtlMs = 60_000,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
}) {
  const entries = new Map(); // key -> { refs, promise, doc, docId, dropped, subs, timer, closing }
  const deferred = []; // keys with refs 0, oldest first
  const byDoc = new Map(); // docId -> key
  let listening = false;
  let generation = 0; // bumped by _reset so a late subscription unlistens itself
  let unlisten = null;

  // Never throws: a close that fails (worker gone) leaves nothing to close.
  const safeClose = (docId) => {
    try { return Promise.resolve(close(docId)).catch(() => {}); } catch { return Promise.resolve(); }
  };

  const listen = () => {
    if (listening || !onUpdated) return;
    listening = true;
    const gen = generation;
    const handler = (p) => {
      const key = byDoc.get(p?.docId);
      const e = key != null ? entries.get(key) : null;
      if (!e?.doc) return;
      e.doc = { ...e.doc, rev: p.rev, meta: p.meta };
      e.subs.forEach(fn => fn(e.doc));
    };
    let sub;
    try { sub = onUpdated(handler); } catch { listening = false; return; }
    Promise.resolve(sub).then((un) => {
      if (gen !== generation) { if (typeof un === 'function') un(); return; }
      unlisten = typeof un === 'function' ? un : null;
    }).catch(() => { if (gen === generation) listening = false; });
  };

  const unDefer = (key) => {
    const i = deferred.indexOf(key);
    if (i >= 0) deferred.splice(i, 1);
    const e = entries.get(key);
    if (e?.timer) { clearTimer(e.timer); e.timer = null; }
  };

  // Returns the close promise (undefined when the doc has no id yet: its open
  // closes it on landing, and parks that close on e.closing).
  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return undefined;
    unDefer(key);
    entries.delete(key);
    e.dropped = true;
    if (e.docId != null) { byDoc.delete(e.docId); return safeClose(e.docId); }
    return undefined;
  };

  const defer = (key) => {
    const e = entries.get(key);
    deferred.push(key);
    e.timer = setTimer(() => { if (entries.get(key) === e && e.refs === 0) drop(key); }, deferredTtlMs);
    while (deferred.length > deferredMax) drop(deferred[0]);
  };

  function acquire(key, params) {
    listen();
    const have = entries.get(key);
    if (have) {
      have.refs += 1;
      unDefer(key);
      return have.doc ? Promise.resolve(have.doc) : have.promise;
    }
    const e = { refs: 1, promise: null, doc: null, docId: null, dropped: false, subs: new Set(), timer: null, closing: null };
    e.promise = open(params).then((r) => {
      if (e.dropped) { e.closing = safeClose(r.docId); throw new Error('render_discarded'); }
      e.docId = r.docId;
      byDoc.set(r.docId, key);
      e.doc = { key, docId: r.docId, rev: r.rev, meta: r.meta };
      if (e.refs === 0 && !deferred.includes(key)) defer(key);
      return e.doc;
    }, (err) => {
      if (entries.get(key) === e) { unDefer(key); entries.delete(key); }
      throw err;
    });
    entries.set(key, e);
    return e.promise;
  }

  // `now`: close as soon as no one else holds the doc (a holder that replaced
  // it with a newer one, or a surface that is not lazy). Without it the doc
  // defers (thread and bubble churn reuse).
  function release(key, { now = false } = {}) {
    const e = entries.get(key);
    if (!e || e.refs === 0) return;
    e.refs -= 1;
    if (e.refs === 0 && e.doc) { if (now) drop(key); else defer(key); }
    else if (e.refs === 0 && now) { e.dropped = true; entries.delete(key); } // still opening: close on landing
  }

  async function closeAll({ waitMs = 1000 } = {}) {
    const all = [...entries.entries()];
    let closed = 0;
    const closes = [];
    const opening = [];
    for (const [key, e] of all) {
      if (e.docId != null) { closes.push(drop(key)); closed += 1; }
      else { drop(key); opening.push(e.promise.then(() => {}, () => e.closing)); closed += 1; }
    }
    if (closes.length || opening.length) {
      let timer;
      const timeout = new Promise((r) => { timer = setTimer(r, waitMs); });
      await Promise.race([Promise.allSettled([...closes, ...opening]), timeout]);
      clearTimer(timer);
    }
    return closed;
  }

  // Tests only: forget every doc without closing, stop timers, drop the bus subscription.
  function reset() {
    for (const e of entries.values()) { if (e.timer) clearTimer(e.timer); e.dropped = true; }
    entries.clear();
    deferred.length = 0;
    byDoc.clear();
    generation += 1;
    listening = false;
    const un = unlisten;
    unlisten = null;
    if (un) un();
  }

  return {
    acquire, release, closeAll,
    subscribe(key, fn) {
      const e = entries.get(key);
      if (!e) return () => {};
      e.subs.add(fn);
      return () => e.subs.delete(fn);
    },
    discard: drop,
    closeDeferred: () => { [...deferred].forEach(drop); },
    openCount: () => [...entries.values()].filter(e => e.docId != null).length,
    liveCount: () => [...entries.values()].filter(e => e.docId != null && e.refs > 0).length,
    deferredCount: () => deferred.length,
    pendingCount: () => [...entries.values()].filter(e => e.docId == null).length,
    docIds: () => [...byDoc.keys()],
    _reset: reset,
  };
}

let shared = null;
/** The app-wide registry (one per webview). */
export function getDocRegistry() {
  shared ||= createDocRegistry({ open: openRender, close: closeRender, onUpdated: onRenderUpdated });
  return shared;
}

/** Tests only: drop the singleton (docs, timers, bus subscription) so the next getDocRegistry() starts clean. */
export function _resetDocRegistryForTest() {
  shared?._reset();
  shared = null;
}
