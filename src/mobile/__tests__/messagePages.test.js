// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createPageCache, compareKeys } from '../messagePages.js';

/** A list of `n` rows newest first, as the engine orders them: (dateMs DESC, uid DESC). */
function listOf(n, { dateOf = (uid) => uid * 1000 } = {}) {
  return Array.from({ length: n }, (_, k) => n - k).map((uid) => ({ uid, dateMs: dateOf(uid) }));
}

/** The engine's cursor page over `rows`: the rows strictly after `cursor`, `limit` of them. */
function fakeFetch(source, listGen = 1) {
  const state = { rows: source, listGen };
  const fn = vi.fn(async (cursor, limit) => {
    const start = cursor == null ? 0 : state.rows.findIndex((r) => compareKeys(r, cursor) > 0);
    const from = start < 0 ? state.rows.length : start;
    const rows = state.rows.slice(from, from + limit);
    const more = from + limit < state.rows.length;
    const last = rows[rows.length - 1];
    return {
      rows,
      nextCursor: more ? { dateMs: last.dateMs, uid: last.uid } : null,
      total: state.rows.length,
      listGen: state.listGen,
    };
  });
  fn.state = state;
  return fn;
}

describe('compareKeys', () => {
  it('orders by date then uid, newest first', () => {
    expect(compareKeys({ dateMs: 2, uid: 1 }, { dateMs: 1, uid: 9 })).toBeLessThan(0);
    expect(compareKeys({ dateMs: 1, uid: 9 }, { dateMs: 1, uid: 2 })).toBeLessThan(0);
    expect(compareKeys({ dateMs: 1, uid: 2 }, { dateMs: 1, uid: 2 })).toBe(0);
    expect(compareKeys({ dateMs: 1, uid: 2 }, { dateMs: 3, uid: 2 })).toBeGreaterThan(0);
  });
});

describe('createPageCache', () => {
  it('cursor_pages_load_in_order', async () => {
    const f = fakeFetch(listOf(1000));
    const c = createPageCache(f);
    await c.ensure(250); // page 2: pages 0 and 1 first, each by the cursor the one before gave
    expect(f.mock.calls.map(([cursor]) => cursor)).toEqual([
      null,
      { dateMs: 901000, uid: 901 },
      { dateMs: 801000, uid: 801 },
    ]);
    expect(f.mock.calls.every(([, limit]) => limit === 100)).toBe(true);
    expect(c.rowAt(250)).toEqual({ uid: 750, dateMs: 750000 });
    expect(c.total).toBe(1000);
    expect(c.listGen).toBe(1);
  });

  it('two ensure(5) calls cause one fetch', async () => {
    const f = fakeFetch(listOf(500));
    const c = createPageCache(f);
    await Promise.all([c.ensure(5), c.ensure(5), c.ensure(99)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.rowAt(5)).toEqual({ uid: 495, dateMs: 495000 });
  });

  it('a page that overlaps a chain in flight is fetched once', async () => {
    const f = fakeFetch(listOf(500));
    const c = createPageCache(f);
    await Promise.all([c.ensure(350), c.ensure(150), c.ensure(250)]);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('past the end is a no-op, not a fetch loop', async () => {
    const f = fakeFetch(listOf(150));
    const c = createPageCache(f);
    await c.ensure(149);
    expect(f).toHaveBeenCalledTimes(2);
    await c.ensure(450);
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.rowAt(450)).toBeUndefined();
  });

  it('a rejected fetch can retry', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ total: 1, rows: [{ uid: 1, dateMs: 1 }], nextCursor: null, listGen: 1 });
    const c = createPageCache(f);
    await expect(c.ensure(0)).rejects.toThrow('boom');
    expect(c.rowAt(0)).toBeUndefined();
    await c.ensure(0);
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.rowAt(0)).toEqual({ uid: 1, dateMs: 1 });
  });

  it('keeps 20 pages, keeps every cursor, and refetches an evicted page by its own cursor', async () => {
    const f = fakeFetch(listOf(3000));
    const c = createPageCache(f);
    await c.ensure(2050); // pages 0..20
    expect(f).toHaveBeenCalledTimes(21);
    expect(c.rowAt(0)).toBeUndefined(); // page 0 was least recently used
    expect(c.rowAt(2050)).toBeDefined();
    f.mockClear();
    await c.ensure(0); // back to the top: one fetch, and page 1 is now the one evicted
    expect(f.mock.calls.map(([cur]) => cur)).toEqual([null]);
    expect(c.rowAt(100)).toBeUndefined();
    f.mockClear();
    // Page 1's rows are gone, its cursor is not: one fetch, from page 0's end.
    await c.ensure(100);
    expect(f.mock.calls.map(([cur]) => cur)).toEqual([{ dateMs: 2901000, uid: 2901 }]);
  });

  it('notifies subscribers when a page lands', async () => {
    const c = createPageCache(fakeFetch(listOf(1000)));
    const seen = vi.fn();
    const off = c.subscribe(seen);
    await c.ensure(0);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    await c.ensure(150);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not reject ensure', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = createPageCache(fakeFetch(listOf(10)));
    c.subscribe(() => { throw new Error('listener broke'); });
    await expect(c.ensure(0)).resolves.toBeUndefined();
    expect(c.rowAt(0)).toBeDefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('honours a custom page size', async () => {
    const f = fakeFetch(listOf(500));
    const c = createPageCache(f, 50);
    await c.ensure(120);
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls.every(([, limit]) => limit === 50)).toBe(true);
  });

  it('invalidate_keeps_anchor_row', async () => {
    const f = fakeFetch(listOf(1000));
    const c = createPageCache(f);
    await c.ensure(250);
    const top = c.rowAt(150);
    // Five new messages land on top and one row above the anchor goes away.
    const fresh = [1005, 1004, 1003, 1002, 1001].map((uid) => ({ uid, dateMs: uid * 1000 }));
    f.state.rows = [...fresh, ...listOf(1000).filter((r) => r.uid !== 900)];
    f.state.listGen = 2;
    expect(c.invalidate(2, 150)).toBe(true);
    expect(c.listGen).toBe(2);
    expect(c.rowAt(150)).toBeUndefined(); // pages dropped
    await c.ensure(150);
    // The anchor row is now four rows lower (+5 added, -1 removed above it).
    expect(c.anchor).toEqual({ dateMs: top.dateMs, uid: top.uid, from: 150, to: 154 });
    expect(c.rowAt(154)).toEqual(top);
    c.clearAnchor();
    expect(c.anchor).toBeNull();
  });

  it('invalidate ignores a generation that is not newer, and keeps no anchor at the top', async () => {
    const f = fakeFetch(listOf(300), 3);
    const c = createPageCache(f);
    await c.ensure(0);
    expect(c.invalidate(3, 10)).toBe(false);
    expect(c.invalidate(2, 10)).toBe(false);
    expect(c.rowAt(0)).toBeDefined();
    expect(c.invalidate(4, 0)).toBe(true);
    expect(c.anchor).toBeNull();
  });

  it('a page in flight across an invalidate is dropped, not stitched into the new generation', async () => {
    const f = fakeFetch(listOf(300));
    const c = createPageCache(f);
    const pending = c.ensure(0);
    c.invalidate(2, 0);
    await pending;
    expect(c.rowAt(0)).toBeUndefined();
    f.state.listGen = 2;
    await c.ensure(0);
    expect(c.rowAt(0)).toBeDefined();
    expect(c.listGen).toBe(2);
  });

  it('a page from a newer generation than the cache holds restarts the list', async () => {
    const f = fakeFetch(listOf(300));
    const c = createPageCache(f);
    await c.ensure(0);
    f.state.listGen = 5;
    f.state.rows = [{ uid: 999, dateMs: 999000 }, ...listOf(300)];
    await c.ensure(150);
    expect(c.listGen).toBe(5);
    // Page 0 of generation 1 is gone: rows of two generations are never shown together.
    await c.ensure(0);
    expect(c.rowAt(0)).toEqual({ uid: 999, dateMs: 999000 });
  });
});

describe('generation order', () => {
  it('a page labelled older than an announced generation does not reset the cache', async () => {
    const f = fakeFetch(listOf(300), 3);
    const c = createPageCache(f);
    await c.ensure(0);
    expect(c.invalidate(5, 0)).toBe(true); // an event announced gen 5
    // The engine still labels its pages 3 (or 4): the rows are kept, the generation stays 5.
    await c.ensure(150);
    expect(c.listGen).toBe(5);
    expect(c.rowAt(0)).toBeDefined();
    expect(c.rowAt(150)).toBeDefined();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a newer page restart keeps the row on screen as the anchor', async () => {
    const f = fakeFetch(listOf(300), 1);
    const c = createPageCache(f);
    await c.ensure(150);
    const top = c.rowAt(120);
    c.topIndex = 120;
    f.state.rows = [{ uid: 999, dateMs: 999000 }, ...listOf(300)];
    f.state.listGen = 2;
    await c.ensure(250); // page 2, read in gen 2: restart
    expect(c.listGen).toBe(2);
    await c.ensure(121);
    expect(c.anchor).toEqual({ dateMs: top.dateMs, uid: top.uid, from: 120, to: 121 });
  });
});
