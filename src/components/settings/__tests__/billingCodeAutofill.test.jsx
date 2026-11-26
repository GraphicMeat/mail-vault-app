// @vitest-environment jsdom
/**
 * After "Sign In to Premium" mails the code, Billing watches this account's Inbox and Spam
 * for it (signinCodeWatch) and, when it arrives, fills it in and signs in: no typing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }));
const billing = {
  fetchSubscriptionStatus: vi.fn(),
  fetchPricing: vi.fn().mockResolvedValue({ currency: 'eur', plans: [] }),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  unregisterBillingClient: vi.fn(),
  signinStart: vi.fn().mockResolvedValue({ ok: true }),
  signinVerify: vi.fn().mockResolvedValue('cus_9'),
  openInBrowser: vi.fn(),
  getClientInfo: vi.fn().mockResolvedValue({ clientId: 'client-1', clientName: 'Mac', platform: 'macos', appVersion: '2.25.1', osVersion: '26' }),
  isBillingRateLimited: () => false,
  getBillingRateLimitedUntil: () => 0,
  BillingRateLimitError: class BillingRateLimitError extends Error {},
};
vi.mock('../../../services/billingApi', () => billing);
const watch = { watchSigninCode: vi.fn() };
vi.mock('../../../services/workflows/signinCodeWatch', () => watch);
vi.mock('../../../services/workflows/billingSeat', () => ({ refreshAddressSignIn: vi.fn().mockResolvedValue(null) }));

const { useSettingsStore, hasPremiumAccess } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');
await import('../../../services/workflows/bindStoreActions');
const { BillingSettings } = await import('../BillingSettings');

beforeEach(() => {
  vi.clearAllMocks();
  useMailStore.setState({ accounts: [{ id: 'a1', email: 'payer@mock.test' }] });
  useSettingsStore.setState({ billingProfile: null, billingEmail: '', billingLastChecked: null, billingCodeSignInNeeded: false, shareGrant: null });
  billing.fetchSubscriptionStatus.mockResolvedValue({
    customerId: 'cus_9', customerEmail: 'payer@mock.test', hasSubscription: true, status: 'active',
    premiumAccess: true, clientAccessGranted: true, activeClients: [],
  });
});
afterEach(cleanup);

describe('Billing code sign-in fills the code in', () => {
  it('signs in with the code found in the mail', async () => {
    let handOver;
    const stop = vi.fn();
    watch.watchSigninCode.mockImplementation(({ onCode }) => { handOver = onCode; return stop; });
    render(<BillingSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign In to Premium/i }));
    await screen.findByTestId('billing-code-form');
    expect(watch.watchSigninCode).toHaveBeenCalledWith(expect.objectContaining({ email: 'payer@mock.test', since: expect.any(Number) }));
    screen.getByText(/checking your Inbox and Spam/i);

    await handOver('806375');
    await waitFor(() => expect(billing.signinVerify).toHaveBeenCalledWith('payer@mock.test', '806375'));
    await waitFor(() => expect(hasPremiumAccess(useSettingsStore.getState().billingProfile)).toBe(true));
    expect(billing.fetchSubscriptionStatus).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cus_9' }));
    expect(stop).toHaveBeenCalled();
  });

  it('stops watching when the code form is cancelled', async () => {
    const stop = vi.fn();
    watch.watchSigninCode.mockReturnValue(stop);
    render(<BillingSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign In to Premium/i }));
    await screen.findByTestId('billing-code-form');
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(stop).toHaveBeenCalled();
  });

  // A 2.25.0 address sign-in stays signed in, but the billing portal and the device list need
  // the Stripe id: Billing offers the code for those instead of a Manage button that fails.
  it('a computer signed in by address gets the code offer for managing its plan', async () => {
    watch.watchSigninCode.mockReturnValue(vi.fn());
    useSettingsStore.setState({
      billingEmail: 'payer@mock.test',
      billingProfile: { customerId: null, customerEmail: 'payer@mock.test', hasSubscription: true, status: 'active', premiumAccess: true, clientAccessGranted: true, activeClients: [] },
      billingLastChecked: Date.now(),
    });
    render(<BillingSettings />);
    screen.getByText(/manage your plan or devices here/i);
    fireEvent.click(screen.getByRole('button', { name: /Email me a code/i }));
    await waitFor(() => expect(billing.signinStart).toHaveBeenCalledWith('payer@mock.test', expect.anything()));
    await screen.findByTestId('billing-code-form');
  });
});
