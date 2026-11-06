// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPageCache, LIST_ACCOUNT, LIST_FOLDER } from '../messagePages.js';

function fakeFetch(total = 10000) {
  return vi.fn(async (offset, limit) => ({
    total,
    rows: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ uid: offset + i })),
  }));
}

describe('createPageCache', () => {
  it('two ensure(5) calls cause one fetch', async () => {
    const f = fakeFetch();
    const c = createPageCache(f);
    await Promise.all([c.ensure(5), c.ensure(5)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(0, 100);
    expect(c.rowAt(5)).toEqual({ uid: 5 });
    expect(c.total).toBe(10000);
    await c.ensure(99);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('row 150 fetches page 1', async () => {
    const f = fakeFetch();
    const c = createPageCache(f);
    expect(c.rowAt(150)).toBeUndefined();
    await c.ensure(150);
    expect(f).toHaveBeenCalledWith(100, 100);
    expect(c.rowAt(150)).toEqual({ uid: 150 });
  });

  it('a rejected fetch can retry', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ total: 10, rows: [{ uid: 0 }] });
    const c = createPageCache(f);
    await expect(c.ensure(0)).rejects.toThrow('boom');
    expect(c.rowAt(0)).toBeUndefined();
    await c.ensure(0);
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.rowAt(0)).toEqual({ uid: 0 });
  });

  it('keeps 20 pages and refetches an evicted one', async () => {
    const f = fakeFetch();
    const c = createPageCache(f);
    for (let p = 0; p <= 20; p++) await c.ensure(p * 100);
    expect(f).toHaveBeenCalledTimes(21);
    expect(c.rowAt(0)).toBeUndefined(); // page 0 was least recently used
    expect(c.rowAt(2000)).toEqual({ uid: 2000 });
    await c.ensure(0);
    expect(f).toHaveBeenCalledTimes(22);
    expect(c.rowAt(0)).toEqual({ uid: 0 });
  });

  it('a read refreshes recency', async () => {
    const f = fakeFetch();
    const c = createPageCache(f);
    for (let p = 0; p < 20; p++) await c.ensure(p * 100);
    c.rowAt(0); // page 0 now most recent; page 1 is the oldest
    await c.ensure(2000);
    expect(c.rowAt(0)).toEqual({ uid: 0 });
    expect(c.rowAt(100)).toBeUndefined();
  });

  it('notifies subscribers when a page lands', async () => {
    const c = createPageCache(fakeFetch());
    const seen = vi.fn();
    const off = c.subscribe(seen);
    await c.ensure(0);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    await c.ensure(500);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('honours a custom page size', async () => {
    const f = fakeFetch();
    const c = createPageCache(f, 50);
    await c.ensure(120);
    expect(f).toHaveBeenCalledWith(100, 50);
  });
});

describe('list source', () => {
  it('queries the account and folder the perf-gate seed writes', () => {
    const seedRs = readFileSync(fileURLToPath(new URL('../../../src-mobile-engine/src/seed.rs', import.meta.url)), 'utf8');
    expect(seedRs).toContain(`pub const ACCOUNT_ID: &str = "${LIST_ACCOUNT}";`);
    expect(seedRs).toContain(`pub const FOLDER: &str = "${LIST_FOLDER}";`);
  });
});
