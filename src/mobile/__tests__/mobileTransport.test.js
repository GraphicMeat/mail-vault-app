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

  it('keeps the data of a rejected { code, message, data }', async () => {
    invoke.mockRejectedValue({ code: 'TOO_LARGE', message: 'attachments are 9 bytes, the limit is 5', data: { limitBytes: 5 } });
    const err = await daemonCall('mobile.compose.send').catch(e => e);
    expect(err.code).toBe('TOO_LARGE');
    expect(err.data).toEqual({ limitBytes: 5 });
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

describe('mobile transport store', () => {
  const MONTHLY = 'com.mailvault.app.premium.monthly';

  it('storeProducts invokes mobile_store_products and keeps the listed fields', async () => {
    const { storeProducts } = await import('../transport.js');
    invoke.mockResolvedValue([
      { id: MONTHLY, title: 'Monthly', price: '$5.99', period: 'P1M', extra: 'x' },
      { id: 'com.mailvault.app.premium.yearly', title: 'Yearly', price: '$39.99', period: 'P1Y',
        introOffer: { price: '$0.00', period: 'P1W', paymentMode: 'freeTrial', periodCount: 1, extra: 'y' } },
    ]);
    await expect(storeProducts()).resolves.toEqual([
      { id: MONTHLY, title: 'Monthly', price: '$5.99', period: 'P1M' },
      { id: 'com.mailvault.app.premium.yearly', title: 'Yearly', price: '$39.99', period: 'P1Y',
        introOffer: { price: '$0.00', period: 'P1W', paymentMode: 'freeTrial', periodCount: 1 } },
    ]);
    expect(invoke.mock.calls).toEqual([['mobile_store_products']]);
    invoke.mockResolvedValue(null);
    await expect(storeProducts()).resolves.toEqual([]);
  });

  it('storePurchase sends the product id and passes no receipt on', async () => {
    const { storePurchase } = await import('../transport.js');
    invoke.mockResolvedValue({ status: 'purchased', platform: 'apple', productId: MONTHLY, jws: 'SECRET',
      premium: { premium: true, source: 'apple', expiresMs: 5, jws: 'SECRET' } });
    const bought = await storePurchase(MONTHLY);
    expect(invoke.mock.calls).toEqual([['mobile_store_purchase', { productId: MONTHLY }]]);
    expect(bought).toEqual({ status: 'purchased', platform: 'apple', productId: MONTHLY,
      premium: { premium: true, source: 'apple', expiresMs: 5 } });
    expect(JSON.stringify(bought)).not.toContain('SECRET');

    invoke.mockResolvedValue({ status: 'purchased', platform: 'google', productId: MONTHLY, error: { code: 'NETWORK' } });
    await expect(storePurchase(MONTHLY)).resolves.toEqual({ status: 'purchased', platform: 'google', productId: MONTHLY, error: { code: 'NETWORK' } });
    invoke.mockResolvedValue({ status: 'pending', platform: 'apple', productId: MONTHLY, premium: { premium: true } });
    await expect(storePurchase(MONTHLY)).resolves.toEqual({ status: 'pending', platform: 'apple', productId: MONTHLY });
    invoke.mockRejectedValue({ code: 'BUSY', message: 'a purchase is already running' });
    await expect(storePurchase(MONTHLY)).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('storeRestore lists verdicts per subscription', async () => {
    const { storeRestore } = await import('../transport.js');
    invoke.mockResolvedValue([
      { platform: 'apple', productId: MONTHLY, error: { code: 'INSTALL_LIMIT' }, jws: 'SECRET' },
      { platform: 'google', productId: MONTHLY, premium: { premium: true, source: 'google', expiresMs: 9 }, token: 'SECRET' },
    ]);
    const items = await storeRestore();
    expect(invoke.mock.calls).toEqual([['mobile_store_restore']]);
    expect(items).toEqual([
      { platform: 'apple', productId: MONTHLY, error: { code: 'INSTALL_LIMIT' } },
      { platform: 'google', productId: MONTHLY, premium: { premium: true, source: 'google', expiresMs: 9 } },
    ]);
    expect(JSON.stringify(items)).not.toContain('SECRET');
    invoke.mockRejectedValue({ code: 'UNAVAILABLE', message: 'the App Store is not available' });
    await expect(storeRestore()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
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
