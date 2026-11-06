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
