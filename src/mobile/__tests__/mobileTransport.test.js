// The mobile entry's own transport: `daemon_rpc` only, engine `{ code, message }` kept intact.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const invoke = vi.fn();
let daemonCall;

beforeAll(async () => {
  globalThis.window = { __TAURI__: { core: { invoke: (...a) => invoke(...a) } } };
  ({ daemonCall } = await import('../transport.js'));
});

beforeEach(() => { invoke.mockReset(); });

describe('mobile transport module', () => {
  it('forwards through daemon_rpc and returns the reply', async () => {
    invoke.mockResolvedValue({ engine: '0.1.0' });
    await expect(daemonCall('mobile.ping')).resolves.toEqual({ engine: '0.1.0' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('daemon_rpc', { method: 'mobile.ping', params: {} });
  });

  it('keeps the engine error code of a rejected { code, message }', async () => {
    invoke.mockRejectedValue({ code: 'UNSUPPORTED', message: 'unsupported method: mobile.nope' });
    const err = await daemonCall('mobile.nope').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('UNSUPPORTED');
    expect(err.message).toBe('unsupported method: mobile.nope');
  });

  it('maps a string rejection to RPC_ERROR', async () => {
    invoke.mockRejectedValue('boom');
    await expect(daemonCall('mobile.ping')).rejects.toMatchObject({ code: 'RPC_ERROR', message: 'boom' });
  });
});

describe('mobile transport file commands', () => {
  it('open_and_share_send_exactly_path_name_mime', async () => {
    const { openFile, shareFile } = await import('../transport.js');
    invoke.mockResolvedValue(null);
    const args = { path: '/c/att/x', name: 'a.pdf', mime: 'application/pdf' };
    await openFile({ ...args, extra: 'dropped' });
    await shareFile(args);
    expect(invoke.mock.calls).toEqual([['mobile_open_file', args], ['mobile_share_file', args]]);
  });

  it('keeps the shell code of a refused open', async () => {
    const { openFile } = await import('../transport.js');
    invoke.mockRejectedValue({ code: 'GONE', message: 'the file is gone' });
    await expect(openFile({ path: '/p', name: '', mime: '' })).rejects.toMatchObject({ code: 'GONE', message: 'the file is gone' });
  });
});

describe('mobile transport listen', () => {
  it('listen_filters_by_name_and_unsubscribes', async () => {
    const { listen } = await import('../transport.js');
    const unlisten = vi.fn();
    let bridge;
    const tauriListen = vi.fn(async (event, cb) => { bridge = { event, cb }; return unlisten; });
    globalThis.window.__TAURI__.event = { listen: tauriListen };
    const seen = [];
    const off = listen('mobile.sync.state', (p) => seen.push(p));
    await Promise.resolve();
    expect(bridge.event).toBe('mobile-event');
    const send = (name, payload) => bridge.cb({ event: 'mobile-event', id: 1, payload: { name, payload } });
    send('mobile.folders.changed', { accountId: 'a' });
    send('mobile.sync.state', { accountId: 'a', state: 'idle' });
    expect(seen).toEqual([{ accountId: 'a', state: 'idle' }]);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    send('mobile.sync.state', { accountId: 'a', state: 'syncing' });
    expect(seen).toHaveLength(1);
  });

  it('unsubscribing before the bridge answers still detaches', async () => {
    const { listen } = await import('../transport.js');
    const unlisten = vi.fn();
    globalThis.window.__TAURI__.event = { listen: async () => unlisten };
    listen('mobile.sync.state', () => {})();
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
