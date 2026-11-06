// Page cache over `mobile.messages.page`. Rows are fetched a page at a time, a page already on its
// way is never asked for twice, and at most `MAX_PAGES` pages stay in memory (least recently used
// goes first), so a 10k list holds 2,000 rows at most.

// The list the mobile shell shows in Plan 1: the account and folder the perf-gate seed writes
// (`ACCOUNT_ID` / `FOLDER` in src-mobile-engine/src/seed.rs; a test checks they match).
export const LIST_ACCOUNT = 'seed-account';
export const LIST_FOLDER = 'INBOX';

export const MAX_PAGES = 20;

/**
 * @param {(offset: number, limit: number) => Promise<{ total: number, rows: object[] }>} fetchPage
 * @param {number} pageSize
 */
export function createPageCache(fetchPage, pageSize = 100) {
  const pages = new Map(); // page number -> rows; Map order is recency, oldest first
  const inflight = new Map(); // page number -> promise
  const listeners = new Set();
  let total = null;

  const touch = (p, rows) => {
    pages.delete(p);
    pages.set(p, rows);
  };

  function load(p) {
    const promise = fetchPage(p * pageSize, pageSize).then(
      (res) => {
        inflight.delete(p);
        total = res.total;
        touch(p, res.rows);
        while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
        // A listener's own failure must not turn a fetched page into a rejected `ensure`.
        for (const fn of listeners) {
          try {
            fn();
          } catch (err) {
            console.error('[mobile] page listener failed', err);
          }
        }
      },
      (err) => {
        inflight.delete(p);
        throw err;
      },
    );
    inflight.set(p, promise);
    return promise;
  }

  return {
    get total() {
      return total;
    },
    get pageSize() {
      return pageSize;
    },
    rowAt(i) {
      const p = Math.floor(i / pageSize);
      const rows = pages.get(p);
      if (!rows) return undefined;
      touch(p, rows);
      return rows[i - p * pageSize];
    },
    ensure(i) {
      const p = Math.floor(i / pageSize);
      if (pages.has(p)) return Promise.resolve();
      return inflight.get(p) ?? load(p);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
