/**
 * The Insights bindings reach the daemon (`daemonCall`), never a Tauri
 * command, and the daemon's `{ok: false, error}` envelope comes back as a
 * rejection carrying its code and coverage with the catalog message.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ calls: [], replies: new Map() }));
vi.mock('../daemonClient.js', () => ({ daemonCall: async (method, params) => {
  if (method === 'daemon.heartbeat') return { alive: true, version: 'test', uptime_secs: 1 };
  h.calls.push([method, params]);
  if (!h.replies.has(method)) throw new Error(`Unexpected method ${method}`);
  return h.replies.get(method);
} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd) => {
  throw new Error(`Insights is daemon-owned: ${cmd} must never reach a Tauri command`);
} }));
beforeEach(() => {
  vi.resetModules();
  h.calls = []; h.replies = new Map();
  globalThis.window ??= {};
  window.__TAURI__ = {};
});
afterEach(() => { delete window.__TAURI__; });

it('sends each RPC with its arguments and unwraps the answer', async () => {
  const api = await import('../insightsApi.js');
  h.replies.set('insights.build', { ok: true, buildId: 'b' });
  h.replies.set('insights.status', { ok: true, state: 'building', loaded: 3 });
  h.replies.set('insights.aggregate', { ok: true, result: { totals: { both: 1 } } });
  h.replies.set('insights.messages', { ok: true, messages: [{ key: 'k' }] });
  h.replies.set('insights.release', { ok: true });
  const accounts = [{ id: 'a', email: 'me@test', sentFolderOverride: 'Sent mail', password: 'never sent', imapHost: 'h' }, { email: 'no-id@test' }];
  expect(await api.buildInsights('b', { accountIds: ['a'], accounts, ownAddressesByAccount: { a: ['me@test'] } })).toEqual({ ok: true, buildId: 'b' });
  expect(await api.insightsStatus('b')).toMatchObject({ state: 'building' });
  expect(await api.aggregateInsights('b', { direction: 'both' })).toEqual({ totals: { both: 1 } });
  expect(await api.insightsMessages('b', { direction: 'both' }, { messageKey: 'k' })).toEqual([{ key: 'k' }]);
  await api.releaseInsights('b');
  await api.releaseInsights(null);
  expect(h.calls).toEqual([
    ['insights.build', { buildId: 'b', accountIds: ['a'], accounts: [{ id: 'a', email: 'me@test', sentFolderOverride: 'Sent mail' }], ownAddressesByAccount: { a: ['me@test'] } }],
    ['insights.status', { buildId: 'b' }],
    ['insights.aggregate', { buildId: 'b', query: { direction: 'both' } }],
    ['insights.messages', { buildId: 'b', query: { direction: 'both' }, selection: { messageKey: 'k' } }],
    ['insights.release', { buildId: 'b' }],
  ]);
});

it('re-raises a failure envelope with its code and coverage and the catalog message', async () => {
  const api = await import('../insightsApi.js');
  h.replies.set('insights.aggregate', { ok: false, error: { code: 'modelExpired', message: 'modelExpired' } });
  h.replies.set('insights.status', { ok: false, error: { code: 'vaultUnavailable', coverage: { status: 'error' } } });
  await expect(api.aggregateInsights('b', {})).rejects.toMatchObject({ code: 'modelExpired' });
  const error = await api.insightsStatus('b').catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: 'vaultUnavailable', coverage: { status: 'error' } });
  expect(error.message).toMatch(/refresh/i);
  expect(error.message).not.toMatch(/vaultUnavailable/);
});
