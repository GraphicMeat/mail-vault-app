import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Task 3.7: the three insights commands are `DAEMON_OWNED` now, so `send`
 * reaches them through `sendToDaemon`, not `tauriInvoke`. The observer seam
 * these e2e assertions depend on (`connected-insights.test.js:38` and `:71`
 * read the names the observer collected; `:313`/`:325` hold one real reply
 * by name) exists on both paths and passes the logical command name on both,
 * never the `daemon_rpc` the call actually travels as. This file is what
 * pins that: it drives the daemon path and the Tauri mock below fails the
 * run if a call falls back to the old one.
 */
const h = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command) => {
  throw new Error(`Insights is daemon-owned: ${command} must never reach tauriInvoke`);
} }));
vi.mock('../daemonClient.js', () => ({
  daemonCall: (method, params) => (method === 'daemon.heartbeat' ? Promise.resolve({ alive: false }) : h.native(method, params)),
}));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.stubEnv('VITE_E2E', '1');
  vi.stubGlobal('window', { __TAURI__: {} });
  h.native.mockReset();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('observes the actual native request and delays delivery without replacing its result', async () => {
  const actual = deferred(), gate = deferred(), observed = [];
  const value = { snapshotId: 'real-native-snapshot', inventoryCount: 17 };
  h.native.mockImplementation((command, args) => {
    expect(command).toBe('insights_begin_snapshot');
    expect(args).toEqual({ accountIds: ['account-b'] });
    return actual.promise;
  });
  window.__INSIGHTS_NATIVE_OBSERVER__ = (command, realPromise) => {
    realPromise.then(result => observed.push({ command, result }));
    return gate.promise;
  };
  const { send } = await import('../transport.js');
  let delivered = false;
  const pending = send('insights_begin_snapshot', { accountIds: ['account-b'] }).then(result => { delivered = true; return result; });
  await vi.advanceTimersByTimeAsync(100);
  actual.resolve(value);
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual([{ command: 'insights_begin_snapshot', result: value }]);
  expect(delivered).toBe(false);
  gate.resolve({ snapshotId: 'observer-must-not-replace-native-data' });
  expect(await pending).toBe(value);
});

it('preserves a real native rejection while the observer records it and delays delivery', async () => {
  const actual = deferred(), gate = deferred(), observed = [];
  const failure = { code: 'snapshotStale', coverage: { status: 'stale' } };
  h.native.mockReturnValue(actual.promise);
  window.__INSIGHTS_NATIVE_OBSERVER__ = (command, realPromise) => {
    realPromise.catch(error => observed.push({ command, error }));
    return gate.promise;
  };
  const { send } = await import('../transport.js');
  let delivered = false;
  const pending = send('insights_read_page', { snapshotId: 'real', cursor: null }).catch(error => { delivered = true; return error; });
  await vi.advanceTimersByTimeAsync(100);
  actual.reject(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual([{ command: 'insights_read_page', error: failure }]);
  expect(delivered).toBe(false);
  gate.reject(new Error('Observer failure must not hide the native rejection'));
  expect(await pending).toBe(failure);
});

it('ignores an observer that throws without changing the actual native result', async () => {
  const value = { snapshotId: 'native' };
  h.native.mockResolvedValue(value);
  window.__INSIGHTS_NATIVE_OBSERVER__ = () => { throw new Error('Observer only'); };
  const { send } = await import('../transport.js');
  const pending = send('insights_begin_snapshot', { accountIds: ['account-b'] });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(value);
});

it('does not invoke the observer when the E2E build flag is disabled', async () => {
  vi.stubEnv('VITE_E2E', '0');
  const value = { snapshotId: 'production-native' }, observed = [];
  h.native.mockResolvedValue(value);
  window.__INSIGHTS_NATIVE_OBSERVER__ = () => { observed.push('unexpected'); return new Promise(() => {}); };
  const { send } = await import('../transport.js');
  const pending = send('insights_begin_snapshot', { accountIds: ['account-b'] });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(value);
  expect(observed).toEqual([]);
});
