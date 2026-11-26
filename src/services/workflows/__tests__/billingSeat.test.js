// @vitest-environment jsdom
/**
 * A computer signed in to Premium by address on 2.25.0 holds a device seat but no Stripe
 * customer id. After updating it stays signed in, no code: the server recognises the seat this
 * device already holds (email + device id) and answers its status. Only when the server says
 * the device holds no seat (or Premium ended) does Billing ask for the emailed code. Offline,
 * nothing changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const billing = {
  fetchSubscriptionStatus: vi.fn(),
  getClientInfo: vi.fn().mockResolvedValue({
    clientId: 'client-held', clientName: 'MacBook Pro', platform: 'macos', appVersion: '2.25.1', osVersion: '26.1',
  }),
  redeemActivation: vi.fn(),
  signinStart: vi.fn(),
};
vi.mock('../../billingApi', () => billing);
vi.mock('../../api', () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }));

const { useSettingsStore, hasPremiumAccess } = await import('../../../stores/settingsStore');
const { refreshAddressSignIn } = await import('../billingSeat');
const { activateWithToken } = await import('../../billingActivation');

const ADDRESS_ONLY = {
  customerId: null, customerEmail: 'payer@mock.test', hasSubscription: true, status: 'trialing',
  premiumAccess: true, clientAccessGranted: true, activeClients: [],
};
const NO_SEAT = { customerId: null, customerEmail: null, hasSubscription: false, premiumAccess: false, clientAccessGranted: false };

beforeEach(() => {
  billing.fetchSubscriptionStatus.mockReset();
  billing.signinStart.mockReset();
  useSettingsStore.setState({
    billingEmail: 'payer@mock.test', billingProfile: ADDRESS_ONLY, billingLastChecked: 1,
    billingCodeSignInNeeded: false, shareGrant: null,
  });
});

describe('refreshAddressSignIn', () => {
  it('keeps a 2.25.0 address sign-in signed in through the seat this device holds', async () => {
    billing.fetchSubscriptionStatus.mockResolvedValue({ ...ADDRESS_ONLY, status: 'active' });
    expect(await refreshAddressSignIn()).toBe('signed-in');
    expect(billing.fetchSubscriptionStatus).toHaveBeenCalledWith(expect.objectContaining({
      email: 'payer@mock.test', clientId: 'client-held', register: true, appVersion: '2.25.1',
    }));
    expect(billing.fetchSubscriptionStatus.mock.calls[0][0].customerId).toBeUndefined();
    const s = useSettingsStore.getState();
    expect(hasPremiumAccess(s.billingProfile)).toBe(true);
    expect(s.billingProfile.status).toBe('active');
    expect(s.billingCodeSignInNeeded).toBe(false);
    expect(billing.signinStart).not.toHaveBeenCalled();
  });

  it('brings back a sign-in an earlier nightly already dropped', async () => {
    useSettingsStore.setState({ billingProfile: null, billingCodeSignInNeeded: true });
    billing.fetchSubscriptionStatus.mockResolvedValue(ADDRESS_ONLY);
    expect(await refreshAddressSignIn()).toBe('signed-in');
    expect(hasPremiumAccess(useSettingsStore.getState().billingProfile)).toBe(true);
    expect(useSettingsStore.getState().billingCodeSignInNeeded).toBe(false);
  });

  it('asks for the code when this device holds no seat', async () => {
    billing.fetchSubscriptionStatus.mockResolvedValue(NO_SEAT);
    expect(await refreshAddressSignIn()).toBe('code-needed');
    const s = useSettingsStore.getState();
    expect(s.billingProfile).toBeNull();
    expect(s.billingCodeSignInNeeded).toBe(true);
    expect(s.billingEmail).toBe('payer@mock.test');
  });

  it('asks for the code when the server refuses an address', async () => {
    billing.fetchSubscriptionStatus.mockRejectedValue(Object.assign(new Error('Sign in with the code'), { status: 400, code: 'customer_id_required' }));
    expect(await refreshAddressSignIn()).toBe('code-needed');
    expect(useSettingsStore.getState().billingCodeSignInNeeded).toBe(true);
  });

  it('changes nothing while the billing server cannot be reached', async () => {
    billing.fetchSubscriptionStatus.mockRejectedValue(new Error('unreachable'));
    expect(await refreshAddressSignIn()).toBe('offline');
    expect(useSettingsStore.getState().billingProfile).toBe(ADDRESS_ONLY);
    expect(useSettingsStore.getState().billingCodeSignInNeeded).toBe(false);
  });

  it('leaves a sign-in with a customer id, and a signed-out install, alone', async () => {
    useSettingsStore.setState({ billingProfile: { ...ADDRESS_ONLY, customerId: 'cus_1' } });
    expect(await refreshAddressSignIn()).toBeNull();
    useSettingsStore.setState({ billingProfile: null, billingCodeSignInNeeded: false });
    expect(await refreshAddressSignIn()).toBeNull();
    useSettingsStore.setState({ billingProfile: null, billingCodeSignInNeeded: true, billingEmail: '' });
    expect(await refreshAddressSignIn()).toBeNull();
    expect(billing.fetchSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('saved settings load without dropping an address sign-in', () => {
    const src = readFileSync('src/stores/settingsStore.js', 'utf8');
    expect(src).not.toMatch(/addressOnlyProfilePatch/);
  });

  it('runs once at startup', () => {
    const src = readFileSync('src/hooks/app/useNativeBridges.js', 'utf8');
    expect(src).toMatch(/refreshAddressSignIn\(\)/);
  });
});

// Paying on the website ends on a mailvault://activate link: that is proof of payment, so the
// app signs in from it with no code, even on a computer that was waiting for one.
describe('activation link after paying', () => {
  it('signs in without a code, and clears a pending code ask', async () => {
    useSettingsStore.setState({ billingProfile: null, billingCodeSignInNeeded: true, billingEmail: 'payer@mock.test' });
    billing.redeemActivation.mockResolvedValue({ customerId: 'cus_9', customerEmail: 'payer@mock.test' });
    billing.fetchSubscriptionStatus.mockResolvedValue({ ...ADDRESS_ONLY, customerId: 'cus_9' });
    const out = await activateWithToken('t'.repeat(24));
    expect(out.ok).toBe(true);
    expect(billing.signinStart).not.toHaveBeenCalled();
    expect(billing.fetchSubscriptionStatus).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cus_9', register: true }));
    const s = useSettingsStore.getState();
    expect(s.billingProfile.customerId).toBe('cus_9');
    expect(s.billingCodeSignInNeeded).toBe(false);
  });
});
