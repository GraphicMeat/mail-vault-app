// @vitest-environment jsdom

/**
 * Settings → Billing offers the same two-plan choice as the onboarding paywall:
 * yearly preselected, one button that buys the chosen plan.
 *
 * lucide-react is deliberately NOT mocked (see billingPremiumDrop.test.jsx).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../services/api', () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }));

const PRICING = {
  currency: 'usd',
  plans: [
    { planId: 'monthly', interval: 'month', amount: 400, formattedAmount: '$4', trialDays: 0, trialEligible: true },
    { planId: 'yearly', interval: 'year', amount: 2500, formattedAmount: '$25', monthlyEquivalent: '$2', savingsPercent: 48, trialDays: 14, trialEligible: true },
  ],
};

vi.mock('../../../services/billingApi', () => ({
  fetchSubscriptionStatus: vi.fn().mockResolvedValue({ hasSubscription: false, premiumAccess: false }),
  fetchPricing: vi.fn(),
  createPortalSession: vi.fn(),
  unregisterBillingClient: vi.fn(),
  openInBrowser: vi.fn(),
  getClientInfo: vi.fn().mockResolvedValue({ clientId: 'c1', clientName: 'Test Mac', platform: 'macos', appVersion: '2.10.3', osVersion: '15.0' }),
  isBillingRateLimited: () => false,
  getBillingRateLimitedUntil: () => 0,
  BillingRateLimitError: class BillingRateLimitError extends Error {},
}));
vi.mock('../../../services/checkout', () => ({ startCheckout: vi.fn() }));

const { fetchPricing } = await import('../../../services/billingApi');
const { startCheckout } = await import('../../../services/checkout');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');
const { setLocale, t } = await import('../../../i18n/index.js');
const { BillingSettings } = await import('../BillingSettings');

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  await setLocale('en');
  useMailStore.setState({ accounts: [{ id: 'a1', email: 'First@Example.com' }] });
  fetchPricing.mockReset();
  fetchPricing.mockResolvedValue(PRICING);
  startCheckout.mockReset();
  startCheckout.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); useMailStore.setState({ accounts: [] }); });

describe('Billing plan picker', () => {
  it('shows yearly preselected and starts its trial on the account address', async () => {
    render(<BillingSettings />);
    const cta = await screen.findByTestId('billing-checkout');
    expect(screen.getAllByRole('radio').map(r => r.value)).toEqual(['yearly', 'monthly']);
    expect(screen.getAllByRole('radio')[0].checked).toBe(true);
    expect(cta.textContent).toContain(t('settings.billing.startFreeTrial'));
    await waitFor(() => expect(cta.disabled).toBe(false));
    fireEvent.click(cta);
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith({ email: 'First@Example.com', planId: 'yearly' }));
  });

  it('buys monthly when monthly is chosen, with the plain Upgrade label', async () => {
    render(<BillingSettings />);
    const cta = await screen.findByTestId('billing-checkout');
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(t('settings.billing.monthly')) }));
    expect(cta.textContent).toContain(t('common.upgrade'));
    await waitFor(() => expect(cta.disabled).toBe(false));
    fireEvent.click(cta);
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith({ email: 'First@Example.com', planId: 'monthly' }));
  });

  it('shows why a checkout did not open', async () => {
    startCheckout.mockResolvedValue({ ok: false, error: 'Could not start checkout.' });
    render(<BillingSettings />);
    const cta = await screen.findByTestId('billing-checkout');
    await waitFor(() => expect(cta.disabled).toBe(false));
    fireEvent.click(cta);
    expect(await screen.findByText('Could not start checkout.')).toBeTruthy();
  });

  it('lets the user switch the notes about Premium off and on', async () => {
    render(<BillingSettings />);
    const box = (await screen.findByTestId('billing-lifecycle-toggle')).querySelector('input');
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useSettingsStore.getState().lifecycleMessages).toBe(false);
    fireEvent.click(box);
    expect(useSettingsStore.getState().lifecycleMessages).toBe(true);
  });
});
