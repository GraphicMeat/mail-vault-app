import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import { listenTo } from '../listenTo.js';

describe('listenTo', () => {
  // Braces: mockReset() returns the mock, and a function returned from a hook
  // is run as its teardown (it would call a rejecting listen once more).
  beforeEach(() => { listen.mockReset(); });

  it('registers the event and hands the callback the payload only', async () => {
    listen.mockResolvedValue(() => {});
    const cb = vi.fn();
    await listenTo('some-event', cb);
    expect(listen).toHaveBeenCalledWith('some-event', expect.any(Function));
    listen.mock.calls[0][1]({ payload: { n: 1 }, event: 'some-event' });
    expect(cb).toHaveBeenCalledWith({ n: 1 });
  });

  it('resolves to the unlisten function Tauri returned', async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    await expect(listenTo('e', () => {})).resolves.toBe(unlisten);
  });

  it('resolves to a no-op unlisten when listen rejects', async () => {
    listen.mockRejectedValue(new Error('no tauri'));
    const unlisten = await listenTo('e', () => {});
    expect(typeof unlisten).toBe('function');
    expect(unlisten()).toBeUndefined();
  });

  it('loads the event API once for listeners requested in the same tick', async () => {
    listen.mockResolvedValue(() => {});
    await Promise.all([listenTo('a', () => {}), listenTo('b', () => {})]);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(listen.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
  });

  it('does not keep a failed load of the event API: the next call loads it again', async () => {
    vi.resetModules();
    let loads = 0;
    const unlisten = vi.fn();
    vi.doMock('@tauri-apps/api/event', () => {
      loads += 1;
      if (loads === 1) throw new Error('event api failed to load');
      return { listen: async () => unlisten };
    });
    const fresh = await import('../listenTo.js');
    const first = await fresh.listenTo('e', () => {});
    expect(first()).toBeUndefined();
    await expect(fresh.listenTo('e', () => {})).resolves.toBe(unlisten);
    vi.doUnmock('@tauri-apps/api/event');
  });
});
