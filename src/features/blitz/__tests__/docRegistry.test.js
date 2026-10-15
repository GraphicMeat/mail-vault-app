import { describe, it, expect, vi } from 'vitest';
import { createDocRegistry, docKey } from '../surfaces/docRegistry';

function harness(over = {}) {
  let next = 1;
  const pending = [];
  const open = vi.fn((params) => new Promise((resolve, reject) => pending.push({ params, resolve: () => resolve({ docId: next++, rev: 1, meta: { cssHeight: 10 } }), reject })));
  const close = vi.fn();
  let updated = null;
  const onUpdated = (cb) => { updated = cb; return () => {}; };
  const timers = [];
  const reg = createDocRegistry({ open, close, onUpdated, deferredMax: 2, deferredTtlMs: 1000,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, ...over });
  const settle = async () => { while (pending.length) pending.shift().resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { reg, open, close, settle, push: (p) => updated(p), timers, pending };
}
const P = (html, w = 600) => ({ html, cssWidth: w, scale: 2, allowRemote: true, theme: { mode: 'light' } });

describe('docKey', () => {
  it('differs on html, width, scale or theme, and is stable otherwise', () => {
    expect(docKey(P('<p>a'))).toBe(docKey(P('<p>a')));
    expect(docKey(P('<p>a'))).not.toBe(docKey(P('<p>b')));
    expect(docKey(P('<p>a', 600))).not.toBe(docKey(P('<p>a', 601)));
    expect(docKey({ ...P('<p>a'), theme: { mode: 'dark' } })).not.toBe(docKey(P('<p>a')));
  });
});

describe('docRegistry', () => {
  it('two holders of one key share one open', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const a = h.reg.acquire(k, P('x'));
    const b = h.reg.acquire(k, P('x'));
    await h.settle();
    expect((await a).docId).toBe((await b).docId);
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it('release keeps the doc deferred; a re-acquire reuses it without opening', async () => {
    const h = harness();
    const k = docKey(P('x'));
    h.reg.acquire(k, P('x')); await h.settle();
    h.reg.release(k);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.reg.deferredCount()).toBe(1);
    const again = await h.reg.acquire(k, P('x'));
    expect(again.docId).toBe(1);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.reg.deferredCount()).toBe(0);
  });

  it('release now closes at once when nobody else holds the doc, not when someone does', async () => {
    const h = harness();
    const a = docKey(P('a')); const b = docKey(P('b'));
    h.reg.acquire(a, P('a')); h.reg.acquire(b, P('b')); h.reg.acquire(b, P('b'));
    await h.settle();
    h.reg.release(a, { now: true });
    expect(h.close).toHaveBeenCalledWith(1);
    expect(h.reg.deferredCount()).toBe(0);
    h.reg.release(b, { now: true });
    expect(h.close).not.toHaveBeenCalledWith(2); // still held once
  });

  it('evicts beyond the deferred cap, oldest first (Review Focus 1)', async () => {
    const h = harness();
    const keys = ['a', 'b', 'c', 'd'].map(s => docKey(P(s)));
    keys.forEach((k, i) => h.reg.acquire(k, P('abcd'[i])));
    await h.settle();
    keys.forEach(k => h.reg.release(k));
    expect(h.reg.deferredCount()).toBe(2);
    expect(h.close.mock.calls.map(c => c[0])).toEqual([1, 2]);
    expect(h.reg.openCount()).toBe(2);
  });

  it('a doc released before its open lands goes deferred, not leaked', async () => {
    const h = harness();
    const k = docKey(P('x'));
    h.reg.acquire(k, P('x'));
    h.reg.release(k);
    await h.settle();
    expect(h.reg.deferredCount()).toBe(1);
    expect(h.reg.openCount()).toBe(1);
  });

  it('discard closes now, even a doc still opening, and the next acquire reopens', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const first = h.reg.acquire(k, P('x'));
    h.reg.discard(k);
    await h.settle();
    await expect(first).rejects.toThrow('render_discarded');
    expect(h.close).toHaveBeenCalledWith(1);
    h.reg.acquire(k, P('x')); await h.settle();
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it('forgetDoc drops the entry that holds a doc the worker evicted; the next acquire opens fresh (3b)', async () => {
    const h = harness();
    const k = docKey(P('x'));
    h.reg.acquire(k, P('x')); await h.settle();
    h.reg.release(k); // deferred, and the daemon evicts it meanwhile
    h.reg.forgetDoc(1);
    expect(h.reg.deferredCount()).toBe(0);
    expect(h.reg.openCount()).toBe(0);
    const again = h.reg.acquire(k, P('x')); await h.settle();
    expect((await again).docId).toBe(2);
    expect(h.open).toHaveBeenCalledTimes(2);
    h.reg.forgetDoc(999); // unknown ids are a no-op
    expect(h.reg.openCount()).toBe(1);
  });

  it('a failed open is forgotten so the next acquire retries', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const p = h.reg.acquire(k, P('x'));
    h.pending.shift().reject(new Error('render_unavailable'));
    await expect(p).rejects.toThrow('render_unavailable');
    h.reg.acquire(k, P('x'));
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it('render-updated reaches subscribers of that doc only', async () => {
    const h = harness();
    const k = docKey(P('x'));
    h.reg.acquire(k, P('x')); await h.settle();
    const seen = vi.fn();
    h.reg.subscribe(k, seen);
    h.push({ docId: 99, rev: 5, meta: {} });
    expect(seen).not.toHaveBeenCalled();
    h.push({ docId: 1, rev: 2, meta: { cssHeight: 20 } });
    expect(seen).toHaveBeenCalledWith({ key: k, docId: 1, rev: 2, meta: { cssHeight: 20 } });
  });

  it('deferred docs close after the idle TTL so the worker can idle out', async () => {
    const h = harness();
    const k = docKey(P('x'));
    h.reg.acquire(k, P('x')); await h.settle();
    h.reg.release(k);
    h.timers.at(-1)();
    expect(h.close).toHaveBeenCalledWith(1);
    expect(h.reg.openCount()).toBe(0);
  });

  it('closeAll closes live and deferred docs now and docs still opening when they land', async () => {
    const h = harness();
    const a = docKey(P('a')); const b = docKey(P('b')); const c = docKey(P('c'));
    h.reg.acquire(a, P('a')); h.reg.acquire(b, P('b')); await h.settle();
    h.reg.release(b);
    h.reg.acquire(c, P('c'));
    const done = h.reg.closeAll({ waitMs: 1000 });
    expect(h.close.mock.calls.map(x => x[0]).sort()).toEqual([1, 2]);
    await h.settle();
    expect(await done).toBe(3);
    expect(h.close).toHaveBeenCalledWith(3);
    expect(h.reg.openCount()).toBe(0);
  });

  it('closeAll awaits every close before it resolves, and a rejecting close does not reject it (F21)', async () => {
    let finish;
    const slow = new Promise(r => { finish = r; });
    const h = harness({ close: vi.fn((id) => (id === 1 ? slow : Promise.reject(new Error('worker gone')))) });
    h.reg.acquire(docKey(P('a')), P('a')); h.reg.acquire(docKey(P('b')), P('b')); await h.settle();
    let resolved = false;
    const done = h.reg.closeAll({ waitMs: 1000 }).then((n) => { resolved = true; return n; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resolved).toBe(false); // docId 1's close is still in flight
    finish();
    expect(await done).toBe(2);
    expect(h.reg.openCount()).toBe(0);
  });

  it('closeAll also awaits the close of a doc that landed after it was dropped (F21)', async () => {
    let finish;
    const slow = new Promise(r => { finish = r; });
    const close = vi.fn(() => slow);
    const h = harness({ close });
    h.reg.acquire(docKey(P('c')), P('c'));
    let resolved = false;
    const done = h.reg.closeAll({ waitMs: 1000 }).then((n) => { resolved = true; return n; });
    await h.settle();
    await Promise.resolve(); await Promise.resolve();
    expect(close).toHaveBeenCalledWith(1);
    expect(resolved).toBe(false);
    finish();
    expect(await done).toBe(1);
  });

  it('release now closes a landed doc at once instead of deferring it (F2)', async () => {
    const h = harness();
    const k = docKey(P('x'));
    h.reg.acquire(k, P('x')); await h.settle();
    h.reg.release(k, { now: true });
    expect(h.close).toHaveBeenCalledWith(1);
    expect(h.reg.deferredCount()).toBe(0);
    expect(h.reg.openCount()).toBe(0);
  });

  it('release now on a doc still opening closes it when it lands (F2)', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const p = h.reg.acquire(k, P('x'));
    p.catch(() => {});
    h.reg.release(k, { now: true });
    await h.settle();
    expect(h.close).toHaveBeenCalledWith(1);
    expect(h.reg.openCount()).toBe(0);
    expect(h.reg.deferredCount()).toBe(0);
  });

  it('onUpdated whose promise rejects is retried by the next acquire and raises nothing (F32)', async () => {
    const calls = [];
    const onUpdated = vi.fn(() => { const p = Promise.reject(new Error('no bus')); calls.push(p); return p; });
    const h = harness({ onUpdated });
    h.reg.acquire(docKey(P('a')), P('a'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(onUpdated).toHaveBeenCalledTimes(1);
    h.reg.acquire(docKey(P('b')), P('b'));
    expect(onUpdated).toHaveBeenCalledTimes(2);
  });

  it('onUpdated that resolves is subscribed once however many acquires follow', async () => {
    const onUpdated = vi.fn(() => Promise.resolve(() => {}));
    const h = harness({ onUpdated });
    h.reg.acquire(docKey(P('a')), P('a'));
    h.reg.acquire(docKey(P('b')), P('b'));
    await Promise.resolve();
    h.reg.acquire(docKey(P('c')), P('c'));
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('release now on a still-opening doc raises no unhandled rejection when the caller ignores acquire (render_discarded)', async () => {
    const seen = [];
    const on = (err) => seen.push(err);
    process.on('unhandledRejection', on);
    try {
      const h = harness();
      const k = docKey(P('x'));
      h.reg.acquire(k, P('x')); // result deliberately dropped, no catch
      h.reg.release(k, { now: true });
      await h.settle();
      await new Promise(r => setTimeout(r, 10)); // let node's unhandled-rejection pass run
      expect(h.close).toHaveBeenCalledWith(1);
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });

  it('a caller that awaits acquire still sees render_discarded', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const p = h.reg.acquire(k, P('x'));
    h.reg.release(k, { now: true });
    await h.settle();
    await expect(p).rejects.toThrow('render_discarded');
  });
});

describe('docRegistry handles: release and discard name the doc they hold', () => {
  it('a release for a doc the key no longer holds is a no-op; the matching one releases', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const a = h.reg.acquire(k, P('x'));
    await h.settle();
    const first = (await a).docId;
    h.reg.discard(k, first); // another holder threw it away
    const b = h.reg.acquire(k, P('x')); // and opened it again
    await h.settle();
    const second = (await b).docId;
    expect(second).not.toBe(first);
    h.reg.release(k, { now: true, docId: first }); // the first holder leaves late
    expect(h.close).not.toHaveBeenCalledWith(second);
    expect(h.reg.liveCount()).toBe(1);
    h.reg.release(k, { now: true, docId: second });
    expect(h.close).toHaveBeenCalledWith(second);
  });

  it('a discard for a doc the key no longer holds leaves the replacement alone; with no docId it is unconditional', async () => {
    const h = harness();
    const k = docKey(P('x'));
    const a = h.reg.acquire(k, P('x'));
    await h.settle();
    const first = (await a).docId;
    h.reg.discard(k, first);
    const b = h.reg.acquire(k, P('x'));
    await h.settle();
    const second = (await b).docId;
    h.reg.discard(k, first);
    expect(h.close).not.toHaveBeenCalledWith(second);
    expect(h.reg.liveCount()).toBe(1);
    h.reg.discard(k);
    expect(h.close).toHaveBeenCalledWith(second);
  });
});
