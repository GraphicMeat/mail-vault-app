import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({
  openRender: vi.fn(async () => ({ docId: 1, rev: 1, meta: { cssHeight: 10 } })),
  closeRender: vi.fn(async () => {}),
  onRenderUpdated: vi.fn(),
}));
vi.mock('../service', () => svc);
import { reportDocGone } from '../surfaces/docGone';
import { getDocRegistry, _resetDocRegistryForTest, docKey } from '../surfaces/docRegistry';

const P = { html: '<p>x', cssWidth: 600, scale: 2, allowRemote: true, theme: { mode: 'light' } };

beforeEach(() => {
  _resetDocRegistryForTest();
  svc.openRender.mockClear();
  svc.closeRender.mockClear();
  svc.onRenderUpdated.mockReset();
  svc.onRenderUpdated.mockImplementation(() => Promise.resolve(() => {}));
});

describe('getDocRegistry / _resetDocRegistryForTest (F2)', () => {
  it('is one instance until reset, then a fresh one', () => {
    const a = getDocRegistry();
    expect(getDocRegistry()).toBe(a);
    _resetDocRegistryForTest();
    expect(getDocRegistry()).not.toBe(a);
  });

  it('a reset registry has no memory of the last test: the same key opens again', async () => {
    const k = docKey(P);
    await getDocRegistry().acquire(k, P);
    _resetDocRegistryForTest();
    await getDocRegistry().acquire(k, P);
    expect(svc.openRender).toHaveBeenCalledTimes(2);
  });

  it('re-subscribes to render-updated after a reset and unlistens the old subscription', async () => {
    const unlisten = vi.fn();
    svc.onRenderUpdated.mockImplementation(() => Promise.resolve(unlisten));
    getDocRegistry().acquire(docKey(P), P);
    await Promise.resolve(); await Promise.resolve();
    expect(svc.onRenderUpdated).toHaveBeenCalledTimes(1);
    _resetDocRegistryForTest();
    expect(unlisten).toHaveBeenCalledTimes(1);
    getDocRegistry().acquire(docKey(P), P);
    expect(svc.onRenderUpdated).toHaveBeenCalledTimes(2);
  });

  it('a reset before the subscription resolves unlistens it as soon as it lands', async () => {
    const unlisten = vi.fn();
    let resolve;
    svc.onRenderUpdated.mockImplementation(() => new Promise(r => { resolve = r; }));
    getDocRegistry().acquire(docKey(P), P).catch(() => {});
    _resetDocRegistryForTest();
    resolve(unlisten);
    await Promise.resolve(); await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('a render-updated payload reaches subscribers through the singleton', async () => {
    let cb;
    svc.onRenderUpdated.mockImplementation((fn) => { cb = fn; return Promise.resolve(() => {}); });
    const k = docKey(P);
    await getDocRegistry().acquire(k, P);
    const seen = vi.fn();
    getDocRegistry().subscribe(k, seen);
    cb({ docId: 1, rev: 3, meta: { cssHeight: 30 } });
    expect(seen).toHaveBeenCalledWith({ key: k, docId: 1, rev: 3, meta: { cssHeight: 30 } });
  });

  it('a rejecting onRenderUpdated raises no unhandled rejection and is retried (F32)', async () => {
    svc.onRenderUpdated.mockImplementation(() => Promise.reject(new Error('no bus')));
    getDocRegistry().acquire(docKey(P), P);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    getDocRegistry().acquire(docKey({ ...P, html: '<p>y' }), { ...P, html: '<p>y' });
    expect(svc.onRenderUpdated).toHaveBeenCalledTimes(2);
  });

  it('render_unknown_doc from any op drops the deferred doc, so the next acquire opens fresh (3b)', async () => {
    const k = docKey(P);
    const reg = getDocRegistry();
    await reg.acquire(k, P);
    reg.release(k); // deferred
    reportDocGone(1, new Error('render_unknown_doc'));
    expect(reg.openCount()).toBe(0);
    svc.openRender.mockResolvedValueOnce({ docId: 2, rev: 1, meta: { cssHeight: 10 } });
    expect((await reg.acquire(k, P)).docId).toBe(2);
    expect(svc.openRender).toHaveBeenCalledTimes(2);
  });

  it('any other error leaves the doc alone, and a reset stops listening', async () => {
    const k = docKey(P);
    const reg = getDocRegistry();
    await reg.acquire(k, P);
    reportDocGone(1, new Error('render_unavailable'));
    expect(reg.openCount()).toBe(1);
    _resetDocRegistryForTest();
    expect(() => reportDocGone(1, new Error('render_unknown_doc'))).not.toThrow();
  });
});
