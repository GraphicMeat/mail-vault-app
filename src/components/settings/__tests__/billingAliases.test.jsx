// @vitest-environment jsdom

/**
 * Settings → Billing: a subscription can belong to any address that is the
 * user, so the selector offers aliases and not just logins.
 *
 * lucide-react is deliberately NOT mocked (see billingPremiumDrop.test.jsx).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../services/api', () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }));

const PRICING = {
  currency: 'usd',
  plans: [{ planId: 'yearly', interval: 'year', amount: 2500, formattedAmount: '$25', trialDays: 14, trialEligible: true }],
};

vi.mock('../../../services/billingApi', () => ({
  fetchSubscriptionStatus: vi.fn(),
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

const { fetchPricing, fetchSubscriptionStatus } = await import('../../../services/billingApi');
const { startCheckout } = await import('../../../services/checkout');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');
const { setLocale, t } = await import('../../../i18n/index.js');
const { BillingSettings } = await import('../BillingSettings');

const LOGIN = 'me@fastmail.test';
const ALIAS = 'Contact@Domain.test';

const selector = () => screen.getByRole('combobox', { name: t('account.emailAddress') });
const listed = () => [...selector().options].map(o => o.value);

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  await setLocale('en');
  useMailStore.setState({ accounts: [{ id: 'a1', email: LOGIN }] });
  useSettingsStore.setState({ aliases: { a1: [{ address: ALIAS, name: '', source: 'manual' }] } });
  fetchPricing.mockReset();
  fetchPricing.mockResolvedValue(PRICING);
  fetchSubscriptionStatus.mockReset();
  fetchSubscriptionStatus.mockResolvedValue({ hasSubscription: false, premiumAccess: false });
  startCheckout.mockReset();
  startCheckout.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); useMailStore.setState({ accounts: [] }); });

describe('Billing address selector', () => {
  it('lists an alias after the login, which stays the default', () => {
    render(<BillingSettings />);
    expect(listed()).toEqual([LOGIN, ALIAS]);
    expect(selector().value).toBe(LOGIN);
  });

  it('lists an alias added while the page is open', async () => {
    useSettingsStore.setState({ aliases: {} });
    render(<BillingSettings />);
    expect(listed()).toEqual([LOGIN]);
    useSettingsStore.setState({ aliases: { a1: [{ address: ALIAS, name: '', source: 'provider' }] } });
    await waitFor(() => expect(listed()).toEqual([LOGIN, ALIAS]));
  });

  it('lists an address held by two accounts once', () => {
    useMailStore.setState({ accounts: [{ id: 'a1', email: LOGIN }, { id: 'a2', email: 'other@mail.test' }] });
    useSettingsStore.setState({ aliases: {
      a1: [{ address: ALIAS, name: '', source: 'manual' }],
      a2: [{ address: ALIAS.toLowerCase(), name: '', source: 'manual' }],
    } });
    render(<BillingSettings />);
    expect(listed()).toEqual([LOGIN, ALIAS, 'other@mail.test']);
  });

  it('preselects a billing email that is an alias', () => {
    useSettingsStore.setState({ billingEmail: ALIAS });
    render(<BillingSettings />);
    expect(selector().value).toBe(ALIAS);
  });

  it('signs in with the chosen alias', async () => {
    render(<BillingSettings />);
    fireEvent.change(selector(), { target: { value: ALIAS } });
    fireEvent.click(screen.getByRole('button', { name: t('settings.billing.signPremium') }));
    await waitFor(() => expect(fetchSubscriptionStatus).toHaveBeenCalled());
    expect(fetchSubscriptionStatus.mock.calls[0][0].email).toBe(ALIAS.toLowerCase());
  });

  it('keeps a mixed-case alias selected after a sign-in that found nothing', async () => {
    render(<BillingSettings />);
    fireEvent.change(selector(), { target: { value: ALIAS } });
    fireEvent.click(screen.getByRole('button', { name: t('settings.billing.signPremium') }));
    await screen.findByText(t('settings.billing.noSubscriptionFoundEmailPick'));
    expect(selector().value).toBe(ALIAS);
  });

  it('starts checkout on the chosen alias', async () => {
    render(<BillingSettings />);
    const cta = await screen.findByTestId('billing-checkout');
    fireEvent.change(selector(), { target: { value: ALIAS } });
    await waitFor(() => expect(cta.disabled).toBe(false));
    fireEvent.click(cta);
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith({ email: ALIAS, planId: 'yearly' }));
  });

  // Same layout as the compose From picker: an account with aliases is a
  // native optgroup (its label greyed and unselectable, its addresses indented).
  describe('grouping', () => {
    const groups = () => [...selector().querySelectorAll('optgroup')];

    it('puts an account and its aliases in one group labelled with the login', () => {
      render(<BillingSettings />);
      expect(groups().map(g => g.label)).toEqual([LOGIN]);
      expect([...groups()[0].querySelectorAll('option')].map(o => o.value)).toEqual([LOGIN, ALIAS]);
    });

    it('leaves an account without aliases as a plain option', () => {
      useMailStore.setState({ accounts: [{ id: 'a1', email: LOGIN }, { id: 'a2', email: 'other@mail.test' }] });
      render(<BillingSettings />);
      expect(groups().map(g => g.label)).toEqual([LOGIN]);
      const other = [...selector().options].find(o => o.value === 'other@mail.test');
      expect(other.parentElement).toBe(selector());
    });

    it('groups nothing when no account has an alias', () => {
      useSettingsStore.setState({ aliases: {} });
      render(<BillingSettings />);
      expect(groups()).toEqual([]);
    });

    it('lists an address held by two accounts under the first only', () => {
      useMailStore.setState({ accounts: [{ id: 'a1', email: LOGIN }, { id: 'a2', email: 'other@mail.test' }] });
      useSettingsStore.setState({ aliases: {
        a1: [{ address: ALIAS, name: '', source: 'manual' }],
        a2: [{ address: ALIAS.toLowerCase(), name: '', source: 'manual' }],
      } });
      render(<BillingSettings />);
      expect(groups().map(g => g.label)).toEqual([LOGIN]);
      expect([...selector().options].map(o => o.value)).toEqual([LOGIN, ALIAS, 'other@mail.test']);
    });
  });
});
