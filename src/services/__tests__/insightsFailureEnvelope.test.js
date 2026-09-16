/**
 * Task 3.7 Step 1. `daemon_rpc` answers `Result<Value, String>`, so the
 * daemon's insights routes cannot return the structured `{code, coverage}`
 * error the deleted Tauri commands returned as an `Err(Value)`. They answer
 * `Ok({ok: false, error: {...}})` instead (plan decision 5), and
 * `insightsApi.js` is the single place that turns that envelope back into a
 * real rejection.
 *
 * This pins the whole JS round trip rather than `insightsApi` alone: the
 * envelope leaves `send`, and `insightsSession.js:94-96` must still see an
 * `Error` carrying both `code` and `coverage`, because that is what decides
 * whether a stale snapshot is retried and what the UI finally reports.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ replies: new Map(), sent: [] }));
vi.mock('../transport.js', () => ({
  send: async (command, args) => {
    h.sent.push([command, args]);
    if (!h.replies.has(command)) throw new Error(`Unexpected command ${command}`);
    return h.replies.get(command);
  },
}));

const api = await import('../insightsApi.js');
const { createInsightsSession } = await import('../insightsSession.js');

/** The worker is not under test here: it answers every build step at once. */
const stubWorker = () => {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    postMessage(message) {
      queueMicrotask(() => listeners.get('message')?.({
        data: {
          type: message.type === 'build-start' ? 'build-started' : 'built',
          requestId: message.requestId,
          payload: message.type === 'build-start' ? { buildId: message.requestId } : [],
        },
      }));
    },
    terminate: () => {},
  };
};
const scope = { accountIds: ['a'], accounts: [{ id: 'a' }], ownAddressesByAccount: { a: ['me@test'] } };
const load = () => {
  const session = createInsightsSession({ api, workerFactory: stubWorker });
  return { session, result: session.load(scope).catch(error => error) };
};

beforeEach(() => { vi.useFakeTimers(); h.replies = new Map(); h.sent = []; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('re-raises a daemon failure envelope as a rejection carrying its code and coverage', async () => {
  const envelope = { ok: false, error: { code: 'snapshotStale', message: 'snapshotStale', coverage: { status: 'stale' } } };
  h.replies.set('insights_begin_snapshot', envelope);
  h.replies.set('insights_read_page', envelope);
  h.replies.set('insights_release_snapshot', { ok: true });

  const { session, result } = load();
  // The session retries a stale snapshot three times before giving up.
  await vi.advanceTimersByTimeAsync(2000);
  const error = await result;

  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: 'snapshotStale', coverage: { status: 'stale' } });
  expect(error.message).toMatch(/refresh/i);
  session.dispose();
});

it('passes a success reply through whether or not it carries the ok flag', async () => {
  // `ok: true` is what the daemon routes add to today's shape; the bare
  // object with no `ok` at all is what `src/demo/backend.js` still returns
  // through its undotted `daemon_rpc` forward, and neither may be mistaken
  // for a failure.
  const rows = [{ accountId: 'a', mailbox: 'INBOX', uid: 17 }];
  for (const flag of [{ ok: true }, {}]) {
    h.sent = [];
    h.replies.set('insights_begin_snapshot', { ...flag, snapshotId: 's1', inventoryCount: 1, coverage: { status: 'reading' } });
    h.replies.set('insights_read_page', { ...flag, rows, nextCursor: null, coverage: { status: 'ready' } });
    h.replies.set('insights_release_snapshot', { ...flag });

    const { session, result } = load();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ loaded: 1, coverage: { status: 'ready' } });
    expect(h.sent.map(([command]) => command)).toContain('insights_release_snapshot');
    session.dispose();
  }
});
