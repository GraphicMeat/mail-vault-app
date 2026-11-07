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

describe('mobile transport pick', () => {
  it('pickFiles invokes mobile_pick_files and returns handles only', async () => {
    const { pickFiles } = await import('../transport.js');
    invoke.mockResolvedValue([
      { handle: 'out/0123456789abcdef/Plan.pdf', name: 'Plan.pdf', size: 15, mime: 'application/pdf', path: '/var/c/out/0123456789abcdef/Plan.pdf' },
      { name: 'Cloud.key', error: 'UNREADABLE', path: '/x' },
    ]);
    const picked = await pickFiles('photos');
    expect(invoke.mock.calls).toEqual([['mobile_pick_files', { kind: 'photos' }]]);
    expect(picked).toEqual([
      { handle: 'out/0123456789abcdef/Plan.pdf', name: 'Plan.pdf', size: 15, mime: 'application/pdf' },
      { name: 'Cloud.key', error: 'UNREADABLE' },
    ]);
    for (const item of picked) expect(item).not.toHaveProperty('path');
  });

  it('a cancelled pick is an empty list and a refusal keeps its code', async () => {
    const { pickFiles } = await import('../transport.js');
    invoke.mockResolvedValue([]);
    await expect(pickFiles('files')).resolves.toEqual([]);
    invoke.mockResolvedValue(null);
    await expect(pickFiles('files')).resolves.toEqual([]);
    invoke.mockRejectedValue({ code: 'BUSY', message: 'a picker is already open' });
    await expect(pickFiles('files')).rejects.toMatchObject({ code: 'BUSY' });
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
