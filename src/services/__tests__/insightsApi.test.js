import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ alive: false, calls: [], release: [], begin: null }));
vi.mock('../daemonClient.js', () => ({ daemonCall: async (cmd) => {
  if (cmd === 'daemon.heartbeat') return { alive: h.alive, version: 'test', uptime_secs: 1 };
  throw new Error('Insights must use the Tauri inventory');
} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd, args) => {
  h.calls.push([cmd, args]);
  if (cmd === 'insights_begin_snapshot') return h.begin ? h.begin : { snapshotId: 's1', inventoryCount: 1, coverage: { status: 'reading', folders: [] } };
  if (cmd === 'insights_read_page') return { rows: [{ accountId: 'a', mailbox: 'INBOX', uid: 17, source: 'server-cache' }], nextCursor: null, coverage: { status: 'ready', folders: [] } };
  if (cmd === 'insights_release_snapshot') { h.release.push(args.snapshotId); return null; }
  throw new Error(`Unexpected command ${cmd}`);
} }));
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  h.calls = []; h.release = []; h.begin = null;
  globalThis.window ??= {};
  window.__TAURI__ = {};
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); delete window.__TAURI__; });

it.each([false, true])('reads camelCase native pages when daemon alive=%s', async (alive) => {
  h.alive = alive;
  const api = await import('../insightsApi.js');
  const starting = api.beginInsightsSnapshot(['a']);
  await vi.advanceTimersByTimeAsync(100);
  const begin = await starting;
  expect((await import('../transport.js')).getDaemonHealth().alive).toBe(alive);
  expect(begin).toEqual({ snapshotId: 's1', inventoryCount: 1, coverage: { status: 'reading', folders: [] } });
  const page = await api.readInsightsPage(begin.snapshotId, null);
  expect(page).toEqual({ rows: [{ accountId: 'a', mailbox: 'INBOX', uid: 17, source: 'server-cache' }], nextCursor: null, coverage: { status: 'ready', folders: [] } });
  await api.releaseInsightsSnapshot(begin.snapshotId);
  expect(h.calls).toEqual([
    ['insights_begin_snapshot', { accountIds: ['a'] }],
    ['insights_read_page', { snapshotId: 's1', cursor: null }],
    ['insights_release_snapshot', { snapshotId: 's1' }],
  ]);
});
it('does not begin after cancellation', async () => {
  const api = await import('../insightsApi.js');
  const controller = new AbortController(); controller.abort();
  await expect(api.beginInsightsSnapshot(['a'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.calls).toEqual([]);
});
it('releases a snapshot that completes after cancellation', async () => {
  let finish;
  h.begin = new Promise(resolve => { finish = resolve; });
  const api = await import('../insightsApi.js');
  const controller = new AbortController();
  const pending = api.beginInsightsSnapshot(['a'], { signal: controller.signal });
  controller.abort();
  finish({ snapshotId: 'late', inventoryCount: 0, coverage: { status: 'ready', folders: [] } });
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(100);
  await cancelled;
  expect(h.release).toEqual(['late']);
});
