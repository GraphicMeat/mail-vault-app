import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startMailtoBridge, setMailtoComposeOpener } from '../mailto';

// The rule this file protects: a mailto: URL handed over by the OS must reach
// compose exactly once, INCLUDING the one that launched the app — that URL is
// queued in Rust before the webview exists, so an event-only bridge would drop
// the first click of every cold start.

let opened;

beforeEach(() => {
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
