// The mobile shell answers `daemon_rpc` with the engine's reply, or rejects with the engine's
// `RpcError` object `{ code, message }`. Both have to come out of `daemonCall` intact.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const invoke = vi.fn();
let daemonCall;

beforeAll(async () => {
  globalThis.window = { __TAURI__: { core: { invoke: (...a) => invoke(...a) } } };
  ({ daemonCall } = await import('../../services/daemonClient.js'));
});

beforeEach(() => { invoke.mockReset(); });

describe('mobile transport', () => {
  it('forwards mobile.ping through daemon_rpc and returns the reply', async () => {
    const reply = { engine: '0.1.0', schema: 1 };
    invoke.mockResolvedValue(reply);
    await expect(daemonCall('mobile.ping')).resolves.toEqual(reply);
    // Loading the settings store for `daemonMode` makes calls of its own (desktop settings
    // reads); only the ping is this test's business.
    const pings = invoke.mock.calls.filter(([cmd, a]) => cmd === 'daemon_rpc' && a?.method === 'mobile.ping');
    expect(pings).toHaveLength(1);
    const [, args] = pings[0];
    expect(args).toMatchObject({ method: 'mobile.ping', params: {} });
    expect(args).toHaveProperty('daemonMode');
  });

  it('keeps the engine error code of a rejected { code, message }', async () => {
    invoke.mockRejectedValue({ code: 'UNSUPPORTED', message: 'unsupported method: mobile.nope' });
    const err = await daemonCall('mobile.nope').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('UNSUPPORTED');
    expect(err.message).toBe('unsupported method: mobile.nope');
    expect(String(err)).not.toContain('[object Object]');
  });

  it('leaves desktop string rejections on the existing codes', async () => {
    invoke.mockRejectedValue('daemon not running');
    await expect(daemonCall('ping')).rejects.toMatchObject({ code: 'DAEMON_OFFLINE', message: 'daemon not running' });
    invoke.mockRejectedValue('rpc failed');
    await expect(daemonCall('ping')).rejects.toMatchObject({ code: 'RPC_ERROR', message: 'rpc failed' });
  });
});
