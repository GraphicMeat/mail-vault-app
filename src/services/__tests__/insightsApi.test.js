/**
 * Task 3.7 moved the three insights commands into the daemon, so this file
 * now mocks `daemonCall` where it used to mock the Tauri `invoke`, and the
 * Tauri mock became the fence: a name that came back to a Tauri command
 * would fail loudly here instead of quietly working.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ alive: false, calls: [], release: [], begin: null }));
const page = { rows: [{ accountId: 'a', mailbox: 'INBOX', uid: 17, source: 'server-cache' }], nextCursor: null, coverage: { status: 'ready', folders: [] } };
vi.mock('../daemonClient.js', () => ({ daemonCall: async (method, params) => {
  if (method === 'daemon.heartbeat') return { alive: h.alive, version: 'test', uptime_secs: 1 };
  h.calls.push([method, params]);
  if (method === 'insights_begin_snapshot') return h.begin ? h.begin : { ok: true, snapshotId: 's1', inventoryCount: 1, coverage: { status: 'reading', folders: [] } };
  if (method === 'insights_read_page') return { ok: true, ...page };
  if (method === 'insights_release_snapshot') { h.release.push(params.snapshotId); return { ok: true }; }
  throw new Error(`Unexpected method ${method}`);
} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd) => {
  throw new Error(`Insights is daemon-owned: ${cmd} must never reach a Tauri command`);
} }));
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  h.calls = []; h.release = []; h.begin = null;
  globalThis.window ??= {};
  window.__TAURI__ = {};
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); delete window.__TAURI__; });

it.each([false, true])('reads camelCase daemon pages without waiting for the heartbeat, alive=%s', async (alive) => {
  h.alive = alive;
  const api = await import('../insightsApi.js');
  const starting = api.beginInsightsSnapshot(['a']);
  await vi.advanceTimersByTimeAsync(100);
  const begin = await starting;
  expect((await import('../transport.js')).getDaemonHealth().alive).toBe(alive);
  expect(begin).toEqual({ ok: true, snapshotId: 's1', inventoryCount: 1, coverage: { status: 'reading', folders: [] } });
  expect(await api.readInsightsPage(begin.snapshotId, null)).toEqual({ ok: true, ...page });
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
  finish({ ok: true, snapshotId: 'late', inventoryCount: 0, coverage: { status: 'ready', folders: [] } });
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(100);
  await cancelled;
  expect(h.release).toEqual(['late']);
});
