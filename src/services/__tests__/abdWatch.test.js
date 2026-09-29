// @vitest-environment jsdom
/**
 * `watchAbd`: a window other than the main one (Settings on its own) follows
 * the job frames. Every caller shares one set of listeners, counted: a second
 * caller is not left without them, and under React StrictMode (mount, cleanup,
 * mount) the first cleanup does not take the listeners the second mount needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: [],
  // One entry per registration, so overlapping attach and detach can be seen.
  live: [],
  daemon: vi.fn(async () => ({})),
}));

vi.mock('../daemonClient', () => ({
  daemonCall: (...args) => h.daemon(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    h.order.push(`listen:${name}`);
    const registration = { name, cb };
    h.live.push(registration);
    return () => { h.live = h.live.filter(r => r !== registration); };
  },
}));
vi.mock('../api', () => ({
  abdAttach: vi.fn(async () => ({ attached: true })),
  abdStart: vi.fn(async () => ({})),
  abdSummarize: vi.fn(),
}));
vi.mock('../authUtils', () => ({ resolveServerAccount: vi.fn(async () => ({ ok: false })) }));
vi.mock('../../stores/accountStore', () => ({
  getAccounts: () => [],
  useAccountStore: (selector) => selector({ accounts: [] }),
}));

const abd = await import('../abd.js');
const { useAbdStore } = await import('../../stores/abdStore.js');

const live = (name) => h.live.filter(r => r.name === name).length;
const asks = () => h.order.map((entry, at) => (entry === 'call:abd.status' ? at : -1)).filter(at => at !== -1);
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  h.order = [];
  h.live = [];
  h.daemon = vi.fn(async (method) => {
    h.order.push(`call:${method}`);
    return method === 'abd.status' ? { jobs: [] } : {};
  });
  abd.__resetAbdForTests();
});
afterEach(() => {
  abd.__resetAbdForTests();
});

describe('watchAbd', () => {
  it('shares one set of listeners between two callers, and keeps it until the last one leaves', async () => {
    const first = await abd.watchAbd();
    const second = await abd.watchAbd();
    expect(live('abd-progress')).toBe(1);
    expect(live('abd-preview')).toBe(1);

    first();
    expect(live('abd-progress')).toBe(1);
    expect(live('abd-preview')).toBe(1);

    second();
    expect(h.live).toEqual([]);
  });

  it('StrictMode: the first mount\'s cleanup does not take the second mount\'s listeners', async () => {
    // mount, cleanup, mount: the second call is made before the first one has resolved.
    const mountA = abd.watchAbd();
    const mountB = abd.watchAbd();
    const stopA = await mountA;
    stopA();
    const stopB = await mountB;
    expect(live('abd-progress')).toBe(1);
    expect(live('abd-preview')).toBe(1);

    // The frames still reach this window's store.
    h.live.find(r => r.name === 'abd-progress').cb({ payload: {
      jobId: 'abd-a-1', accountId: 'a', status: { state: 'running' }, counts: {}, finished: false, updatedMs: 5,
    } });
    expect(useAbdStore.getState().jobs.a.jobId).toBe('abd-a-1');

    stopB();
    expect(h.live).toEqual([]);
  });

  it('a release called twice counts once', async () => {
    const first = await abd.watchAbd();
    const second = await abd.watchAbd();
    first();
    first();
    expect(live('abd-progress')).toBe(1);
    second();
    expect(h.live).toEqual([]);
  });

  it('attaches again for a caller that comes after everyone left', async () => {
    (await abd.watchAbd())();
    expect(h.live).toEqual([]);
    const again = await abd.watchAbd();
    expect(live('abd-progress')).toBe(1);
    again();
  });

  it('every caller asks for the frames after the listeners are up, a caller that joins the attach too', async () => {
    const a = abd.watchAbd();
    const b = abd.watchAbd();
    await a;
    await b;
    await settle();
    const listenedAt = Math.max(h.order.indexOf('listen:abd-progress'), h.order.indexOf('listen:abd-preview'));
    expect(asks()).toHaveLength(2);
    for (const at of asks()) expect(at).toBeGreaterThan(listenedAt);
  });

  it('in the main window (initAbd ran) it adds nothing and its release takes nothing', async () => {
    await abd.initAbd();
    const before = h.live.length;
    const stop = await abd.watchAbd();
    expect(h.live.length).toBe(before);
    stop();
    expect(h.live.length).toBe(before);
  });
});
