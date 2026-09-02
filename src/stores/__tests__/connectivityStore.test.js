import { describe, it, expect, beforeEach, vi } from 'vitest';

// Node environment: no DOM. The store reads `navigator.onLine` at creation and
// `window.__TAURI__` on the fallback path, so both have to exist.
if (!globalThis.window) globalThis.window = {};
vi.stubGlobal('navigator', { onLine: true });

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const {
  useConnectivityStore,
  wireConnectivityEvents,
  installNetMock,
  __resetConnectivityForTests,
} = await import('../connectivityStore');

/** Minimal event target — the webview's path-monitor events, nothing else. */
function fakeWindow() {
  const handlers = {};
  return {
    addEventListener: (name, fn) => { (handlers[name] ||= []).push(fn); },
    emit: (name) => (handlers[name] || []).forEach(fn => fn()),
    handlers,
  };
}

beforeEach(() => {
  __resetConnectivityForTests();
  mockDaemonCall.mockReset();
  delete globalThis.window.__TAURI__;
});

describe('connectivity store', () => {
  it('takes the daemon probe as the authority', async () => {
    mockDaemonCall.mockResolvedValue({ online: false });

    const verdict = await useConnectivityStore.getState().probe();

    expect(verdict).toBe(false);
    expect(useConnectivityStore.getState().online).toBe(false);
    expect(mockDaemonCall).toHaveBeenCalledWith('net.probe');
  });

  // The daemon answers `{online: bool}` and the Tauri command answers a bare
  // bool. `{online:false}` is truthy — read raw, an offline daemon reports
  // "online" and the banner never shows.
  it('narrows the daemon envelope instead of trusting its truthiness', async () => {
    mockDaemonCall.mockResolvedValue({ online: false });
    expect(await useConnectivityStore.getState().probe()).toBe(false);

    __resetConnectivityForTests();
    mockDaemonCall.mockResolvedValue({ online: true });
    expect(await useConnectivityStore.getState().probe()).toBe(true);
  });

  it('falls back to the Tauri command when no daemon answers', async () => {
    mockDaemonCall.mockRejectedValue(new Error('daemon not running'));
    const invoke = vi.fn().mockResolvedValue(false);
    globalThis.window.__TAURI__ = { core: { invoke } };

    const verdict = await useConnectivityStore.getState().probe();

    expect(invoke).toHaveBeenCalledWith('check_network_connectivity');
    expect(verdict).toBe(false);
    expect(useConnectivityStore.getState().online).toBe(false);
  });

  it('trusts an offline event outright but makes an online event prove itself', async () => {
    const win = fakeWindow();
    wireConnectivityEvents(win);

    win.emit('offline');
    expect(useConnectivityStore.getState().online).toBe(false);

    // A joined captive-portal Wi-Fi fires `online` with no internet behind it,
    // so the event must trigger a probe rather than set the flag.
    mockDaemonCall.mockResolvedValue({ online: false });
    win.emit('online');
    await vi.waitFor(() => expect(mockDaemonCall).toHaveBeenCalledWith('net.probe'));
    expect(useConnectivityStore.getState().online).toBe(false);

    mockDaemonCall.mockResolvedValue({ online: true });
    await useConnectivityStore.getState().probe();
    expect(useConnectivityStore.getState().online).toBe(true);
  });

  it('collapses concurrent probes into one', async () => {
    let release;
    mockDaemonCall.mockReturnValue(new Promise(r => { release = () => r({ online: true }); }));

    const probes = [
      useConnectivityStore.getState().probe(),
      useConnectivityStore.getState().probe(),
      useConnectivityStore.getState().probe(),
    ];
    release();
    await Promise.all(probes);

    expect(mockDaemonCall).toHaveBeenCalledTimes(1);
  });

  describe('mock connectivity object', () => {
    it('pins the verdict against heartbeats and probes', async () => {
      installNetMock(globalThis.window);
      globalThis.window.__mvNet.setOnline(false);
      expect(useConnectivityStore.getState().online).toBe(false);

      // A heartbeat saying otherwise must not un-pin it, or an e2e assertion
      // would race the daemon's 30s tick.
      useConnectivityStore.getState().setOnline(true);
      expect(useConnectivityStore.getState().online).toBe(false);

      mockDaemonCall.mockResolvedValue({ online: true });
      expect(await useConnectivityStore.getState().probe()).toBe(false);
      expect(mockDaemonCall).not.toHaveBeenCalled();
    });

    it('releases the pin and re-probes for real', async () => {
      installNetMock(globalThis.window);
      globalThis.window.__mvNet.setOnline(false);
      mockDaemonCall.mockResolvedValue({ online: true });

      await globalThis.window.__mvNet.release();

      expect(useConnectivityStore.getState().online).toBe(true);
      expect(globalThis.window.__mvNet.online).toBe(true);
    });
  });
});
