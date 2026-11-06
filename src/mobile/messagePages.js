// Page cache over the cursor form of `mobile.messages.page`. Row `i` lives on page
// `floor(i / pageSize)`; page `p` is fetched with the cursor page `p - 1` ended on, so pages load
// in order and a page whose cursor is not known yet waits for the ones before it. Rows of at most
// `MAX_PAGES` pages stay in memory (least recently used goes first); cursors are a few bytes each
// and are all kept, so a page that was evicted comes back with one fetch.
//
// `listGen` is the engine's per-folder generation. When it moves (an event, or a page that comes
// back newer than the pages held) every page and cursor is dropped: rows of two generations are
// never shown side by side. `invalidate` keeps the key of the top visible row as an anchor and
// reports where that row landed once the reloaded pages reach it, so the list can hold its place.

export const MAX_PAGES = 20;
export const PAGE_SIZE = 100;

/** The engine's list order, `(dateMs DESC, uid DESC)`: negative when `a` sorts before `b`. */
export function compareKeys(a, b) {
  if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
  return b.uid - a.uid;
}

const END = Symbol('end');

/**
 * @param {(cursor: null|{dateMs:number, uid:number}, limit: number) =>
 *   Promise<{ rows: object[], nextCursor: null|{dateMs:number, uid:number}, total: number, listGen: number }>} fetchPage
 * @param {number} pageSize
 */
export function createPageCache(fetchPage, pageSize = PAGE_SIZE) {
  const pages = new Map(); // page number -> rows; Map order is recency, oldest first
  const cursors = new Map([[0, null]]); // page number -> cursor that fetches it, or END
  const inflight = new Map(); // page number -> promise
  const listeners = new Set();
  let total = null;
  let listGen = null;
  let epoch = 0; // bumped by every reset; a reply from an older epoch is dropped
  let version = 0;
  let anchor = null; // { dateMs, uid, from, to: number|null }
  let topIndex = 0; // first row on screen, set by the list as it scrolls

  const notify = () => {
    // A listener's own failure must not turn a fetched page into a rejected `ensure`.
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[mobile] page listener failed', err);
      }
    }
  };

  const touch = (p, rows) => {
    pages.delete(p);
    pages.set(p, rows);
  };

  function reset(gen) {
    pages.clear();
    cursors.clear();
    cursors.set(0, null);
    inflight.clear();
    epoch++;
    version++;
    listGen = gen;
  }

  function findAnchor(p, rows) {
    if (!anchor || anchor.to != null) return;
    const j = rows.findIndex((r) => compareKeys(r, anchor) >= 0);
    if (j >= 0) anchor.to = p * pageSize + j;
    else if (cursors.get(p + 1) === END) anchor.to = Math.max(0, p * pageSize + rows.length - 1);
  }

  function load(p) {
    const mine = epoch;
    const promise = fetchPage(cursors.get(p), pageSize).then(
      (res) => {
        if (mine !== epoch) return; // the list moved on while this page was on its way
        inflight.delete(p);
        if (listGen != null && res.listGen != null && res.listGen !== listGen) {
          // The engine's list moved under the pages held: start over in the new generation.
          reset(res.listGen);
          total = res.total;
          notify();
          return;
        }
        listGen = res.listGen ?? listGen;
        total = res.total;
        cursors.set(p + 1, res.nextCursor ?? END);
        touch(p, res.rows);
        while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
        findAnchor(p, res.rows);
        notify();
      },
      (err) => {
        if (mine === epoch) inflight.delete(p);
        throw err;
      },
    );
    inflight.set(p, promise);
    return promise;
  }

  function ensurePage(p) {
    if (pages.has(p)) return Promise.resolve();
    const running = inflight.get(p);
    if (running) return running;
    const cursor = cursors.get(p);
    if (cursor === END) return Promise.resolve(); // past the end of the list
    if (cursor !== undefined) return load(p);
    // Unknown cursor: the page before has to come first. Walk back to the nearest known one.
    const mine = epoch;
    return ensurePage(p - 1).then(() => (mine === epoch && cursors.has(p) ? ensurePage(p) : undefined));
  }

  return {
    get total() {
      return total;
    },
    get pageSize() {
      return pageSize;
    },
    get listGen() {
      return listGen;
    },
    /** Bumped by every drop of the pages, so a view can ask for its rows again. */
    get version() {
      return version;
    },
    /** The first row on screen. The list writes it; `invalidate` anchors on it. */
    get topIndex() {
      return topIndex;
    },
    set topIndex(i) {
      topIndex = i;
    },
    /** `{dateMs, uid, from, to}` after `invalidate`; `to` is null until the row is found again. */
    get anchor() {
      return anchor;
    },
    clearAnchor() {
      anchor = null;
    },
    rowAt(i) {
      const p = Math.floor(i / pageSize);
      const rows = pages.get(p);
      if (!rows) return undefined;
      touch(p, rows);
      return rows[i - p * pageSize];
    },
    ensure(i) {
      return ensurePage(Math.floor(i / pageSize));
    },
    /**
     * The folder changed to generation `gen`. Drops every page unless `gen` is not newer than the
     * one held, and keeps the row at `top` (the first row on screen by default) as the anchor;
     * none at the very top, where new mail should show. Returns whether anything was dropped.
     */
    invalidate(gen, top = topIndex) {
      if (gen != null && listGen != null && gen <= listGen) return false;
      const row = top > 0 ? this.rowAt(top) : undefined;
      anchor = row ? { dateMs: row.dateMs, uid: row.uid, from: top, to: null } : null;
      reset(gen ?? listGen);
      notify();
      return true;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
