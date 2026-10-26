const { api } = vi.hoisted(() => ({ api: { redeem: null, status: null } }));
vi.mock('../billingApi', () => ({
  redeemActivation: (...a) => api.redeem(...a),
  fetchSubscriptionStatus: (...a) => api.status(...a),
  getClientInfo: async () => ({ clientId: 'client-1', clientName: 'My Mac', platform: 'macos', appVersion: '2.21.0', osVersion: '15' }),
}));
vi.mock('../../stores/focusStore', () => ({ notify: vi.fn() }));
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import { notify } from '../../stores/focusStore';
import { parseActivationUrl, activateWithToken, announceActivation, startActivationBridge } from '../billingActivation';

// A web checkout ends on a page that opens mailvault://activate?token=...  The
// app spends the token for who paid, then signs in through the ordinary status
// call so the 5-device registration stays in one place.

const TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
const URL_OK = `mailvault://activate?token=${TOKEN}`;
const PAID = { customerId: 'cus_1', customerEmail: 'buyer@example.com' };
const premium = { customerId: 'cus_1', customerEmail: 'buyer@example.com', hasSubscription: true, status: 'trialing', premiumAccess: true, clientAccessGranted: true, activeClients: [], clientLimit: 5, activeClientCount: 1 };

beforeEach(() => {
  api.redeem = vi.fn().mockResolvedValue(PAID);
  api.status = vi.fn().mockResolvedValue(premium);
  notify.mockClear();
  useSettingsStore.setState({ billingEmail: '', billingProfile: null });
});

describe('parseActivationUrl', () => {
  it('takes the token from an activate link', () => {
    expect(parseActivationUrl(URL_OK)).toBe(TOKEN);
    expect(parseActivationUrl(`MAILVAULT://activate?token=${TOKEN}&x=1`)).toBe(TOKEN);
  });
  it.each([
    ['another scheme', `https://mailvaultapp.com/activate?token=${TOKEN}`],
    ['mailto', 'mailto:a@b.test'],
    ['another host', `mailvault://settings?token=${TOKEN}`],
    ['no token', 'mailvault://activate'],
    ['a short token', 'mailvault://activate?token=abc'],
    ['markup in the token', 'mailvault://activate?token=%3Cimg%20src%3Dx%3E%3Cimg%20src%3Dx%3E'],
    ['not a string', null],
  ])('ignores %s', (_n, href) => {
    expect(parseActivationUrl(href)).toBeNull();
  });
});

describe('activateWithToken', () => {
  it('signs a fresh install in: spends the token, registers this device, stores the profile', async () => {
    const out = await activateWithToken(TOKEN);
    expect(out).toEqual({ ok: true, result: premium });
    expect(api.redeem).toHaveBeenCalledWith(TOKEN);
    expect(api.status).toHaveBeenCalledWith({
      customerId: 'cus_1', email: 'buyer@example.com', clientId: 'client-1', register: true,
      clientName: 'My Mac', platform: 'macos', appVersion: '2.21.0', osVersion: '15',
    });
    const s = useSettingsStore.getState();
    expect(s.billingEmail).toBe('buyer@example.com');
    expect(s.billingProfile).toMatchObject({ customerId: 'cus_1', premiumAccess: true });
  });

  it('says expired for a token that was already used, and stores nothing', async () => {
    api.redeem = vi.fn().mockRejectedValue(Object.assign(new Error('used'), { status: 410 }));
    expect(await activateWithToken(TOKEN)).toEqual({ ok: false, reason: 'expired' });
    expect(api.status).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().billingProfile).toBeNull();
  });

  it('says unreachable when the billing server cannot be reached', async () => {
    api.redeem = vi.fn().mockRejectedValue(new Error('network'));
    expect(await activateWithToken(TOKEN)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('stays signed out when the subscription grants nothing', async () => {
    api.status = vi.fn().mockResolvedValue({ ...premium, hasSubscription: false, premiumAccess: false, status: 'canceled' });
    expect(await activateWithToken(TOKEN)).toMatchObject({ ok: false, reason: 'no_premium' });
    expect(useSettingsStore.getState().billingEmail).toBe('');
  });

  it('says unreachable, not expired, when the sign-in call fails after the token was spent', async () => {
    api.status = vi.fn().mockRejectedValue(new Error('network'));
    expect(await activateWithToken(TOKEN)).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('announceActivation', () => {
  it('tells the user it worked', () => {
    announceActivation({ ok: true, result: premium });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0].join(' ')).toContain('buyer@example.com');
  });
  it('tells the user why it did not', () => {
    announceActivation({ ok: false, reason: 'expired' });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('startActivationBridge', () => {
  function bridge({ queued = [] } = {}) {
    const handlers = {};
    const unlisten = vi.fn();
    const invoke = vi.fn(async (cmd) => { if (cmd === 'take_pending_activation') return queued.splice(0); return null; });
    const listen = vi.fn(async (name, cb) => { handlers[name] = cb; return unlisten; });
    const results = [];
    const b = startActivationBridge({ invoke, listen, onResult: r => results.push(r) });
    return { b, invoke, listen, handlers, unlisten, results, queued };
  }

  it('drains the link that launched the app (queued before the webview existed)', async () => {
    const t = bridge({ queued: [URL_OK] });
    await t.b.ready;
    await t.b.idle();
    expect(api.redeem).toHaveBeenCalledTimes(1);
    expect(t.results).toEqual([{ ok: true, result: premium }]);
  });

  it('drains again when the OS delivers a link to the running app', async () => {
    const t = bridge();
    await t.b.ready;
    t.queued.push(URL_OK);
    t.handlers['activation-open']();
    await t.b.idle();
    expect(api.redeem).toHaveBeenCalledTimes(1);
    expect(t.listen).toHaveBeenCalledWith('activation-open', expect.any(Function));
  });

  it('never spends a token from a link that is not an activation link', async () => {
    const t = bridge({ queued: ['mailto:a@b.test', 'mailvault://settings'] });
    await t.b.ready;
    await t.b.idle();
    expect(api.redeem).not.toHaveBeenCalled();
  });

  it('spends two queued tokens one after the other', async () => {
    const second = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F';
    const t = bridge({ queued: [URL_OK, `mailvault://activate?token=${second}`] });
    await t.b.ready;
    await t.b.idle();
    expect(api.redeem.mock.calls.map(c => c[0])).toEqual([TOKEN, second]);
  });

  it('detaches on stop', async () => {
    const t = bridge();
    await t.b.ready;
    t.b.stop();
    expect(t.unlisten).toHaveBeenCalled();
  });
});
