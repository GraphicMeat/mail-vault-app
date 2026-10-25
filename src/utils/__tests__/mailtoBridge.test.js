const { preparationIO } = vi.hoisted(() => ({ preparationIO: { failure: false, gate: null, calls: [] } }));
vi.mock('../../stores/safeStorage', async original => ({ ...(await original()), flushSafeStorage: vi.fn(async () => 0) }));
vi.mock('../../services/transport', () => ({ send: async (_method, p) => {
  preparationIO.calls.push(p);
  if (preparationIO.gate) await preparationIO.gate;
  if (preparationIO.failure) { preparationIO.failure = false; throw new Error('compose.preparationUnavailable'); }
  const { prepareDemoCompose } = await import('../../demo/composePrep');
  return prepareDemoCompose(p, { accounts: [], values: {}, version: 0 });
} }));
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startMailtoBridge, setMailtoComposeOpener, retryMailtoCompose } from '../mailto';

// The rule this file protects: a mailto: URL handed over by the OS must reach
// compose exactly once, INCLUDING the one that launched the app — that URL is
// queued in Rust before the webview exists, so an event-only bridge would drop
// the first click of every cold start.

let opened;

beforeEach(() => {
  preparationIO.failure = false; preparationIO.gate = null; preparationIO.calls = [];
  opened = [];
  setMailtoComposeOpener(d => opened.push(d));
});

/**
 * A fake `listen` that models the real one: it hands back an `unlisten` that
 * actually detaches, so firing after a stop is a no-op here for the same
 * reason it is in Tauri.
 */
function fakeListen() {
  const handlers = {};
  const unlisten = vi.fn(() => { delete handlers['mailto-open']; });
  let resolveAttach;
  const attached = new Promise(r => { resolveAttach = r; });
  const listen = vi.fn((name, cb) => attached.then(() => {
    handlers[name] = cb;
    return unlisten;
  }));
  // Deferred by default so a test can stop the bridge mid-attach; most tests
  // just settle it immediately.
  return {
    listen, unlisten,
    settle: () => { resolveAttach(); return attached; },
    fire: name => handlers[name]?.(),
  };
}

describe('startMailtoBridge', () => {
  it('does not deliver a destructively taken URL after teardown', async () => {
    const { listen, settle } = fakeListen();
    let release;
    const invoke = vi.fn(() => new Promise(r => { release = r; }));
    settle();
    const bridge = startMailtoBridge({ invoke, listen });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    bridge.stop();
    release(['mailto:retained@example.test']);
    await bridge.ready;
    expect(opened).toHaveLength(0);
    const next = startMailtoBridge({ invoke: vi.fn().mockResolvedValue([]), listen: async () => () => {} });
    await next.ready;
    expect(opened.map(d => d.to)).toEqual(['retained@example.test']);
    next.stop();
  });

  it('opens compose for a URL already queued before the bridge started', async () => {
    const { listen, settle } = fakeListen();
    const invoke = vi.fn().mockResolvedValueOnce(['mailto:cold@start.test']);

    settle();
    await startMailtoBridge({ invoke, listen }).ready;

    expect(invoke).toHaveBeenCalledWith('take_pending_mailto');
    expect(opened).toHaveLength(1);
    expect(opened[0].to).toBe('cold@start.test');
  });

  it('drains again when the OS hands over a URL while the app is running', async () => {
    const { listen, settle, fire } = fakeListen();
    const invoke = vi.fn()
      .mockResolvedValueOnce([])                        // nothing queued at start
      .mockResolvedValueOnce(['mailto:warm@run.test']); // arrives with the event

    settle();
    await startMailtoBridge({ invoke, listen }).ready;
    expect(opened).toHaveLength(0);

    await fire('mailto-open');

    expect(opened).toHaveLength(1);
    expect(opened[0].to).toBe('warm@run.test');
  });

  it('detaches even when stopped before the listener finished attaching', async () => {
    // The leak the `active` flag guards against in every App.jsx listener:
    // unmount lands while `listen()` is still in flight, so the handler is
    // registered after the cleanup has already run.
    const { listen, unlisten, settle } = fakeListen();
    const invoke = vi.fn().mockResolvedValue([]);

    const { stop, ready } = startMailtoBridge({ invoke, listen });
    stop();            // cleanup runs synchronously, mid-attach
    await settle();
    await ready;

    expect(unlisten).toHaveBeenCalled();
  });

  it('opens nothing when the OS hands over something that is not a mailto', async () => {
    const { listen, settle } = fakeListen();
    const invoke = vi.fn().mockResolvedValueOnce(['https://example.com', '']);

    settle();
    await startMailtoBridge({ invoke, listen }).ready;

    expect(opened).toHaveLength(0);
  });
});

it('retains failed ordered occurrences and retries without retaking lost shell URLs', async () => {
  const invoke = vi.fn().mockResolvedValue(['mailto:same@example.test', 'mailto:same@example.test', 'mailto:last@example.test?bcc=private@example.test']);
  preparationIO.failure = true;
  const errors = [];
  const bridge = startMailtoBridge({ invoke, listen: async () => () => {}, onError: e => errors.push(e.message) });
  await expect(bridge.ready).rejects.toThrow('compose.preparationUnavailable');
  expect(opened).toEqual([]);
  await retryMailtoCompose();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(opened.map(d => d.to)).toEqual(['same@example.test', 'same@example.test', 'last@example.test']);
  expect(opened[2].bcc).toBe('private@example.test');
  expect(errors).toEqual(['compose.preparationUnavailable']);
  bridge.stop();
});
it('fences a native reply when the opener changes and delivers on explicit retry', async () => {
  let release; preparationIO.gate = new Promise(r => { release = r; });
  const old = [];
  setMailtoComposeOpener(d => old.push(d));
  const invoke = vi.fn().mockResolvedValue(['mailto:fenced@example.test']);
  const bridge = startMailtoBridge({ invoke, listen: async () => () => {} });
  await vi.waitFor(() => expect(preparationIO.calls).toHaveLength(1));
  setMailtoComposeOpener(d => opened.push(d));
  release(); await bridge.ready;
  expect(old).toEqual([]); expect(opened).toEqual([]);
  await retryMailtoCompose();
  expect(opened.map(d => d.to)).toEqual(['fenced@example.test']);
  bridge.stop();
});
