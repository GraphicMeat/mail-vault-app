// Page cache over the cursor form of `mobile.messages.page`. Row `i` lives on page
// `floor(i / pageSize)`; page `p` is fetched with the cursor page `p - 1` ended on, so pages load
// in order and a page whose cursor is not known yet waits for the ones before it. Rows of at most
// `MAX_PAGES` pages stay in memory (least recently used goes first); cursors are a few bytes each
// and are all kept, so a page that was evicted comes back with one fetch.
//
// `listGen` is the engine's per-folder generation. When it moves (an event, or a page that comes
// back newer than the pages held) every page and cursor is dropped, so rows of two generations
// are never shown side by side. A page labelled older than the generation held was read after
// the newer one was announced: its rows are kept and the generation never steps back.
// A drop keeps the key of the top visible row as an anchor and reports where that row landed
// once the reloaded pages reach it, so the list can hold its place.
//
// `hide(uids)` takes rows out of the view without the engine (a move or delete waiting out its
// undo toast): indices, `total` and `rowAt` skip hidden rows among the pages held. Only rows the
// user could see are ever hidden, so they are on a held page.

export const MAX_PAGES = 20;
export const PAGE_SIZE = 100;

/**
 * The engine's list order, `(dateMs DESC, uid DESC)`, then `accountId DESC` in a list that spans
 * accounts (All Inboxes), where one `(dateMs, uid)` can repeat: negative when `a` sorts before `b`.
 */
export function compareKeys(a, b) {
  if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
  if (a.uid !== b.uid) return b.uid - a.uid;
  const x = a.accountId ?? '';
  const y = b.accountId ?? '';
  return x === y ? 0 : x < y ? 1 : -1;
}

const END = Symbol('end');

/**
 * @param {(cursor: null|{dateMs:number, uid:number}, limit: number) =>
 *   Promise<{ rows: object[], nextCursor: null|{dateMs:number, uid:number}, total: number, listGen: number }>} fetchPage
 * @param {number} pageSize
 * @param {{ spansAccounts?: boolean }} options `spansAccounts`: the rows come from several
 *   accounts (All Inboxes, each row with its `accountId`). A uid then names a row only with its
 *   account, so rows are hidden and found by `keyFor(accountId, uid)`. The list's generation is a
 *   sum over the accounts and is not comparable with one folder's event: such a list ignores it
 *   and drops its pages on every `invalidate()`.
 */
export function createPageCache(fetchPage, pageSize = PAGE_SIZE, { spansAccounts = false } = {}) {
  const keyFor = spansAccounts ? (accountId, uid) => `${accountId}:${uid}` : (_accountId, uid) => uid;
  const keyOf = (r) => keyFor(r.accountId, r.uid);
  const pages = new Map(); // page number -> rows; Map order is recency, oldest first
  const cursors = new Map([[0, null]]); // page number -> cursor that fetches it, or END
  const inflight = new Map(); // page number -> promise
  const listeners = new Set();
  let total = null;
  let listGen = null;
  let epoch = 0; // bumped by every reset; a reply from an older epoch is dropped
  let version = 0;
  let anchor = null; // { dateMs, uid, accountId?, from, to: number|null }
  let topIndex = 0; // first row on screen (raw index), set by the list as it scrolls
  const hidden = new Set(); // keys (`keyFor`) of the rows taken out of the view
  let hiddenAt = []; // sorted raw indices of hidden rows on held pages; null = recount

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

  function hiddenIndices() {
    if (!hidden.size) return [];
    if (hiddenAt) return hiddenAt;
    const out = [];
    for (const [p, rows] of pages) {
      rows.forEach((r, j) => {
        if (r && hidden.has(keyOf(r))) out.push(p * pageSize + j);
      });
    }
    hiddenAt = out.sort((a, b) => a - b);
    return hiddenAt;
  }

  /** View index -> index in the engine's list, stepping over hidden rows. */
  function toRaw(i) {
    if (!hidden.size) return i;
    let raw = i;
    for (const h of hiddenIndices()) {
      if (h <= raw) raw++;
      else break;
    }
    return raw;
  }

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
    hiddenAt = null;
  }

  /** Drops every page for generation `gen`, keeping the row at `top` (if not the first) as anchor. */
  function dropAll(gen, top) {
    const p = Math.floor(top / pageSize);
    const row = top > 0 ? pages.get(p)?.[top - p * pageSize] : undefined;
    anchor = row ? { dateMs: row.dateMs, uid: row.uid, accountId: row.accountId, from: top, to: null } : null;
    reset(gen);
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
      (reply) => {
        if (mine !== epoch) return; // the list moved on while this page was on its way
        const res = spansAccounts ? { ...reply, listGen: null } : reply;
        inflight.delete(p);
        if (listGen != null && res.listGen != null && res.listGen > listGen) {
          // The engine's list moved under the pages held: start over in the new generation,
          // holding the row on screen like an `invalidate` does.
          dropAll(res.listGen, topIndex);
          total = res.total;
          notify();
          return;
        }
        // A page labelled older than the generation held (an event announced the newer one
        // first) was still read after that event: keep its rows, never step the generation back.
        if (res.listGen != null && (listGen == null || res.listGen > listGen)) listGen = res.listGen;
        total = res.total;
        cursors.set(p + 1, res.nextCursor ?? END);
        touch(p, res.rows);
        while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
        hiddenAt = null;
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
    /** Rows in the view: the engine's total less the hidden rows. */
    get total() {
      return total == null ? null : Math.max(0, total - hiddenIndices().length);
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
      topIndex = toRaw(i);
    },
    /** `{dateMs, uid, from, to}` after `invalidate`; `to` is null until the row is found again. */
    get anchor() {
      return anchor;
    },
    clearAnchor() {
      anchor = null;
    },
    rowAt(i) {
      const raw = toRaw(i);
      const p = Math.floor(raw / pageSize);
      const rows = pages.get(p);
      if (!rows) return undefined;
      touch(p, rows);
      return rows[raw - p * pageSize];
    },
    ensure(i) {
      return ensurePage(Math.floor(toRaw(i) / pageSize));
    },
    /** The key that names the row `uid` of `accountId` here: the uid, or both in a spanning list. */
    keyFor,
    /** View index of the row `key` (`keyFor`) on the held pages, or -1 (not held, or hidden). */
    indexOf(key) {
      for (const [p, rows] of pages) {
        const j = rows.findIndex((r) => r && keyOf(r) === key);
        if (j < 0) continue;
        if (hidden.has(key)) return -1;
        const raw = p * pageSize + j;
        return raw - hiddenIndices().filter((h) => h < raw).length;
      }
      return -1;
    },
    /** View index of the row `uid` of a one-folder list on the held pages, or -1. */
    indexOfUid(uid) {
      return this.indexOf(uid);
    },
    /** Takes the rows of `keys` (`keyFor`) out of the view (the engine still lists them). */
    hide(keys) {
      for (const key of keys) hidden.add(key);
      hiddenAt = null;
      notify();
    },
    /** Puts hidden rows back (an undo), or forgets them once the engine has taken them out. */
    unhide(keys) {
      for (const key of keys) hidden.delete(key);
      hiddenAt = null;
      notify();
    },
    /**
     * The folder changed to generation `gen`. Drops every page unless `gen` is not newer than the
     * one held, and keeps the row at `top` (the first row on screen by default) as the anchor;
     * none at the very top, where new mail should show. Returns whether anything was dropped.
     */
    invalidate(gen, top = topIndex) {
      if (gen != null && listGen != null && gen <= listGen) return false;
      dropAll(gen ?? listGen, top);
      notify();
      return true;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
