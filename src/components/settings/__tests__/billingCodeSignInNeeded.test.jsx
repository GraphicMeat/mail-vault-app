// @vitest-environment jsdom

/**
 * From 2.25.1 Premium is signed in with the emailed code, which proves the address.
 *
 * A 2.25.0 address sign-in stays signed in through the device seat it holds (billingSeat).
 * When the server says this device holds no seat, the sign-in is dropped and Billing asks for
 * the code, with the address already picked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../../services/api', () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../services/workflows/billingSeat', () => ({ refreshAddressSignIn: vi.fn().mockResolvedValue('code-needed') }));
vi.mock('../../../services/billingApi', () => ({
  fetchSubscriptionStatus: vi.fn(),
  fetchPricing: vi.fn().mockResolvedValue({ currency: 'eur', plans: [] }),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  unregisterBillingClient: vi.fn(),
  signinStart: vi.fn(),
  signinVerify: vi.fn(),
  openInBrowser: vi.fn(),
  getClientInfo: vi.fn().mockResolvedValue({
    clientId: 'client-1', clientName: 'Test Mac', platform: 'macos', appVersion: '2.25.1', osVersion: '15.0',
  }),
  isBillingRateLimited: () => false,
  getBillingRateLimitedUntil: () => 0,
  BillingRateLimitError: class BillingRateLimitError extends Error {},
}));

const { useSettingsStore, hasPremiumAccess } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');
await import('../../../services/workflows/bindStoreActions');
const { BillingSettings } = await import('../BillingSettings');

// What the server answers a 2.25.0 address sign-in: Premium, but no customer id.
const ADDRESS_ONLY = {
  customerId: null, customerEmail: 'payer@mock.test', hasSubscription: true, status: 'active',
  interval: 'month', premiumAccess: true, clientAccessGranted: true, activeClients: [],
};

describe('Billing after an address-only profile was dropped', () => {
  beforeEach(() => {
    useMailStore.setState({ accounts: [{ id: 'a1', email: 'payer@mock.test' }] });
    useSettingsStore.setState({
      billingProfile: null, billingEmail: 'payer@mock.test', billingLastChecked: null,
      billingCodeSignInNeeded: true, shareGrant: null,
    });
  });
  afterEach(cleanup);

  it('says why and asks for the code, with the paid address picked', async () => {
    render(<BillingSettings />);
    await screen.findByText(/sign in again with the code we email you/i);
    expect(hasPremiumAccess(useSettingsStore.getState().billingProfile)).toBe(false);
    const picked = screen.getAllByRole('combobox').map(el => el.value);
    expect(picked).toContain('payer@mock.test');
  });

  it('clears the ask once a signed-in profile with a customer id arrives', () => {
    useSettingsStore.getState().setBillingProfile({ ...ADDRESS_ONLY, customerId: 'cus_1' });
    expect(useSettingsStore.getState().billingCodeSignInNeeded).toBe(false);
  });

  it('keeps the ask while profiles without a customer id arrive', () => {
    useSettingsStore.getState().setBillingProfile({ hasSubscription: false, customerId: null });
    expect(useSettingsStore.getState().billingCodeSignInNeeded).toBe(true);
  });
});
