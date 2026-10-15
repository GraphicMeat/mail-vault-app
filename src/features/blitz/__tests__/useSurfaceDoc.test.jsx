// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { createDocRegistry } from '../surfaces/docRegistry';

const keyCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../surfaces/docRegistry', async (orig) => {
  const actual = await orig();
  return { ...actual, docKey: (p) => { keyCalls.n += 1; return actual.docKey(p); }, getDocRegistry: () => { throw new Error('use the injected registry'); } };
});
import { useSurfaceDoc } from '../surfaces/useSurfaceDoc';

afterEach(cleanup);

const meta = { cssWidth: 600, cssHeight: 100, tileCssHeight: 512, tileCount: 1, links: [], plainText: '', folds: [] };
const P = (over = {}) => ({ html: '<p>x', cssWidth: 600, scale: 2, allowRemote: true, theme: { mode: 'light' }, ...over });

// A registry whose opens the test lands by hand.
function fakeRegistry() {
  const pending = [];
  const reg = {
    pending,
    acquire: vi.fn((key) => new Promise((resolve, reject) => pending.push({ key, resolve: (docId) => resolve({ key, docId, rev: 1, meta }), reject }))),
    release: vi.fn(),
    discard: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
  return reg;
}
const land = (reg, docId = 1) => act(async () => { reg.pending.shift().resolve(docId); await Promise.resolve(); });

describe('useSurfaceDoc', () => {
  it('hashes the key only when its inputs change, not on every render (F18)', async () => {
    const reg = fakeRegistry();
    keyCalls.n = 0;
    const { rerender } = renderHook(({ p }) => useSurfaceDoc(p, { registry: reg }), { initialProps: { p: P() } });
    const first = keyCalls.n;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) rerender({ p: P() }); // a fresh but equal params object, as every hover re-render gives
    expect(keyCalls.n).toBe(first);
    rerender({ p: P({ html: '<p>y' }) });
    expect(keyCalls.n).toBeGreaterThan(first);
  });

  it('null params open nothing and are not busy', () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useSurfaceDoc(null, { registry: reg }));
    expect(reg.acquire).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    expect(result.current.doc).toBeNull();
  });

  it('busy until the doc lands; keeps the sent width with it', async () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useSurfaceDoc(P({ cssWidth: 480 }), { registry: reg }));
    expect(result.current.busy).toBe(true);
    await land(reg);
    expect(result.current.busy).toBe(false);
    expect(result.current.doc.docId).toBe(1);
    expect(result.current.sentWidth).toBe(480);
  });

  it('a key change keeps the old doc up (busy) until the new one lands, then releases the old one now', async () => {
    const reg = fakeRegistry();
    const { result, rerender } = renderHook(({ p }) => useSurfaceDoc(p, { registry: reg }), { initialProps: { p: P() } });
    await land(reg, 1);
    const oldKey = result.current.key;
    rerender({ p: P({ html: '<p>next' }) });
    expect(result.current.doc.docId).toBe(1);
    expect(result.current.busy).toBe(true);
    await land(reg, 2);
    expect(result.current.doc.docId).toBe(2);
    expect(result.current.busy).toBe(false);
    expect(reg.release).toHaveBeenCalledWith(oldKey, { now: true, docId: 1 });
  });

  it('a reply superseded before it landed is released at once and never painted', async () => {
    const reg = fakeRegistry();
    const { result, rerender } = renderHook(({ p }) => useSurfaceDoc(p, { registry: reg }), { initialProps: { p: P() } });
    const staleKey = result.current.key;
    rerender({ p: P({ html: '<p>next' }) });
    await land(reg, 1); // the stale one
    expect(reg.release).toHaveBeenCalledWith(staleKey, { now: true, docId: 1 });
    expect(result.current.doc).toBeNull();
    await land(reg, 2);
    expect(result.current.doc.docId).toBe(2);
  });

  it('unmount releases with deferral when asked, at once otherwise', async () => {
    for (const [deferOnUnmount, now] of [[true, false], [false, true]]) {
      const reg = fakeRegistry();
      const { result, unmount } = renderHook(() => useSurfaceDoc(P(), { registry: reg, deferOnUnmount }));
      await land(reg);
      const key = result.current.key;
      unmount();
      expect(reg.release).toHaveBeenCalledWith(key, { now, docId: 1 });
    }
  });

  it('unmounted while still opening: a lazy body keeps the doc for reuse, others drop it', async () => {
    for (const [deferOnUnmount, now] of [[true, false], [false, true]]) {
      const reg = fakeRegistry();
      const { result, unmount } = renderHook(() => useSurfaceDoc(P(), { registry: reg, deferOnUnmount }));
      const key = result.current.key;
      unmount();
      await land(reg);
      expect(reg.release).toHaveBeenCalledWith(key, { now, docId: 1 });
    }
  });

  it('an open discarded under a body that still wants it (another holder retried) is not a failure: it opens again', async () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useSurfaceDoc(P(), { registry: reg }));
    await act(async () => { reg.pending.shift().reject(new Error('render_discarded')); await Promise.resolve(); });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(true);
    expect(reg.acquire).toHaveBeenCalledTimes(2);
    await land(reg, 7);
    expect(result.current.doc.docId).toBe(7);
  });

  it('an open discarded after this body went away is ignored', async () => {
    const reg = fakeRegistry();
    const { unmount } = renderHook(() => useSurfaceDoc(P(), { registry: reg }));
    unmount();
    await act(async () => { reg.pending.shift().reject(new Error('render_discarded')); await Promise.resolve(); });
    expect(reg.acquire).toHaveBeenCalledTimes(1);
  });

  it('an open error is the error; retry discards the key, drops the doc at once and opens again', async () => {
    const reg = fakeRegistry();
    const { result } = renderHook(() => useSurfaceDoc(P(), { registry: reg }));
    await land(reg, 1);
    const key = result.current.key;
    act(() => { result.current.retry(1); });
    expect(reg.discard).toHaveBeenCalledWith(key, 1);
    expect(result.current.doc).toBeNull(); // the discarded doc's tiles are gone in the same render
    expect(result.current.busy).toBe(true);
    expect(reg.acquire).toHaveBeenCalledTimes(2);
    await act(async () => { reg.pending.shift().reject(new Error('render_unknown_doc')); await Promise.resolve(); });
    expect(result.current.error).toBe('render_unknown_doc');
    expect(result.current.busy).toBe(false);
    // the discarded doc was not also released: nothing holds it
    expect(reg.release).not.toHaveBeenCalledWith(key, expect.anything());
  });
});

// The same hook over a REAL registry (a fake open that lands by hand, a close spy).
describe('useSurfaceDoc over a real registry: per-doc handles', () => {
  function real() {
    const opens = [];
    let next = 1;
    const close = vi.fn(async () => {});
    const registry = createDocRegistry({
      open: (p) => new Promise((resolve) => opens.push(() => resolve({ docId: next++, rev: 1, meta }))),
      close,
    });
    const land = () => act(async () => { opens.shift()(); await Promise.resolve(); await Promise.resolve(); });
    return { registry, opens, close, land };
  }
  const mount = (registry, over = {}, opts = {}) => renderHook(({ p }) => useSurfaceDoc(p, { registry, ...opts }), { initialProps: { p: P(over) } });

  it('two holders of one key: A retries, then B releases: A\'s reopened doc is neither closed nor deferred', async () => {
    const { registry, close, land } = real();
    const a = mount(registry); const b = mount(registry);
    await land();
    expect(a.result.current.doc.docId).toBe(1);
    expect(b.result.current.doc.docId).toBe(1);
    act(() => { a.result.current.retry(1); });
    expect(close).toHaveBeenCalledWith(1);
    b.unmount(); // B still held the dead entry: its release must not touch the replacement
    await land();
    expect(a.result.current.doc.docId).toBe(2);
    expect(close).not.toHaveBeenCalledWith(2);
    expect(registry.deferredCount()).toBe(0);
    expect(registry.liveCount()).toBe(1);
  });

  it('B\'s late failure after A\'s reopen landed does not discard it; B joins it', async () => {
    const { registry, close, land } = real();
    const a = mount(registry); const b = mount(registry);
    await land();
    act(() => { a.result.current.retry(1); });
    await land();
    expect(a.result.current.doc.docId).toBe(2);
    act(() => { b.result.current.retry(1); }); // B's tile of the dead doc 1 errors late
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(close).not.toHaveBeenCalledWith(2);
    expect(b.result.current.doc.docId).toBe(2); // joined, no third open
    expect(registry.liveCount()).toBe(1);
    expect(registry.openCount()).toBe(1);
    a.unmount();
    expect(close).not.toHaveBeenCalledWith(2); // B still holds it
    b.unmount();
    expect(close).toHaveBeenCalledWith(2);
  });

  it('returning to the key on screen before the other open lands takes no second ref: unmount closes the doc', async () => {
    const { registry, close, land } = real();
    const { result, rerender, unmount } = mount(registry);
    await land();
    const docId = result.current.doc.docId;
    rerender({ p: P({ html: '<p>other' }) }); // K2 pending
    rerender({ p: P() }); // back to K before K2 lands
    await land(); // K2 lands: nobody wants it
    expect(result.current.doc.docId).toBe(docId);
    unmount();
    expect(close).toHaveBeenCalledWith(docId);
    expect(registry.openCount()).toBe(0);
  });
});
