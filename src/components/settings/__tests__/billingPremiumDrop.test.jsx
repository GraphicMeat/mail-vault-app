// @vitest-environment jsdom

/**
 * A subscription that ends between two refreshes must SAY so.
 *
 * 2026-08-27: the app sat with `billingEmail` set and a profile that had just
 * come back `hasSubscription: false`. Premium features stopped, the Billing tab
 * quietly read "Free", and nothing anywhere said why. This mounts the tab the
 * way the app does — signed in, stale — and asserts the refresh announces the
 * drop instead of re-rendering as Free.
 *
 * lucide-react is deliberately NOT mocked: the Proxy mock in this directory
 * breaks the moment a component actually renders an icon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const sendNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../services/api', () => ({ sendNotification }));

const FREE_PROFILE = {
  customerId: 'cus_V2LwNvtWmdRnO0',
  customerEmail: 'butcher@mock.test',
  hasSubscription: false,
  status: null,
  premiumAccess: false,
  clientAccessGranted: false,
};

const fetchSubscriptionStatus = vi.fn().mockResolvedValue(FREE_PROFILE);
vi.mock('../../../services/billingApi', () => ({
  fetchSubscriptionStatus: (...a) => fetchSubscriptionStatus(...a),
  fetchPricing: vi.fn().mockResolvedValue({ currency: 'eur', plans: [] }),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  unregisterBillingClient: vi.fn(),
  openInBrowser: vi.fn(),
  getClientInfo: vi.fn().mockResolvedValue({
    clientId: 'client-1', clientName: 'Test Mac', platform: 'macos',
    appVersion: '2.10.3', osVersion: '15.0',
  }),
  isBillingRateLimited: () => false,
  getBillingRateLimitedUntil: () => 0,
  BillingRateLimitError: class BillingRateLimitError extends Error {},
}));

const { useSettingsStore } = await import('../../../stores/settingsStore');
// accountStore is a thin hook over mailStore — the state lives there.
const { useMailStore } = await import('../../../stores/mailStore');
const { BillingSettings } = await import('../BillingSettings');

const PREMIUM_PROFILE = {
  customerId: 'cus_V2LwNvtWmdRnO0',
  customerEmail: 'butcher@mock.test',
  hasSubscription: true,
  status: 'active',
  interval: 'year',
  premiumAccess: true,
  clientAccessGranted: true,
};

/** Signed in on this device, last checked long enough ago to refresh on mount. */
function signedInAndStale() {
  useMailStore.setState({ accounts: [{ id: 'a1', email: 'butcher@mock.test' }] });
  useSettingsStore.setState({
    billingProfile: PREMIUM_PROFILE,
    billingEmail: 'butcher@mock.test',
    billingLastChecked: 1,
    shareGrant: null,
  });
}

describe('Billing — premium that ends between refreshes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSubscriptionStatus.mockResolvedValue(FREE_PROFILE);
    signedInAndStale();
  });
  afterEach(cleanup);

  it('tells the user premium ended instead of silently showing Free', async () => {
    render(<BillingSettings />);
    await waitFor(() => expect(fetchSubscriptionStatus).toHaveBeenCalled());
    await screen.findByText(/Premium access ended on this device/i);
  });

  it('notifies outside the app — this can land while the tab is not open', async () => {
    render(<BillingSettings />);
    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    const [title, body] = sendNotification.mock.calls[0];
    expect(title).toMatch(/Premium/i);
    expect(body).toMatch(/Premium access ended on this device/i);
  });

  it('drops the stored identity so the UI is signed out, not half signed in', async () => {
    render(<BillingSettings />);
    await waitFor(() => expect(useSettingsStore.getState().billingEmail).toBe(''));
    expect(useSettingsStore.getState().billingProfile.hasSubscription).toBe(false);
  });

  it('says nothing when the refresh confirms the subscription is fine', async () => {
    fetchSubscriptionStatus.mockResolvedValue({ ...PREMIUM_PROFILE });
    render(<BillingSettings />);
    await waitFor(() => expect(fetchSubscriptionStatus).toHaveBeenCalled());
    expect(sendNotification).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().billingEmail).toBe('butcher@mock.test');
    expect(screen.queryByText(/Premium access ended/i)).toBe(null);
  });
});

describe('Billing — the issues question before Manage Subscription', () => {
  const TRIAL_PROFILE = { ...PREMIUM_PROFILE, status: 'trialing', currentPeriodEnd: '2026-11-10T00:00:00Z' };
  const mockApi = async () => await import('../../../services/billingApi');
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await mockApi();
    api.createPortalSession.mockResolvedValue({ url: 'https://portal.test/s' });
    api.openInBrowser.mockResolvedValue(true);
  });
  afterEach(cleanup);

  function mountAs(profile, onReportBug = () => {}) {
    fetchSubscriptionStatus.mockResolvedValue(profile);
    signedInAndStale();
    useSettingsStore.setState({ billingProfile: profile });
    render(<BillingSettings onReportBug={onReportBug} />);
  }

  it.each([['a free trial', TRIAL_PROFILE], ['a paid subscription', PREMIUM_PROFILE]])(
    'does not show the question inline, and Manage Subscription raises it as a modal for %s', async (_n, profile) => {
      const api = await mockApi();
      mountAs(profile);
      const manage = await screen.findByText('Manage Subscription');
      expect(screen.queryByRole('dialog')).toBe(null);
      expect(screen.queryByTestId('billing-issues-question')).toBe(null);
      fireEvent.click(manage);
      expect(screen.getByRole('dialog').textContent).toMatch(/having issues with MailVault/i);
      expect(api.createPortalSession).not.toHaveBeenCalled();
    });

  it('No goes straight on to the billing portal', async () => {
    const api = await mockApi();
    mountAs(TRIAL_PROFILE);
    fireEvent.click(await screen.findByText('Manage Subscription'));
    fireEvent.click(screen.getByTestId('billing-issues-no'));
    await waitFor(() => expect(api.openInBrowser).toHaveBeenCalledWith('https://portal.test/s'));
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('Yes reaches the report menu and does not open the portal', async () => {
    const api = await mockApi();
    const onReportBug = vi.fn();
    mountAs(TRIAL_PROFILE, onReportBug);
    fireEvent.click(await screen.findByText('Manage Subscription'));
    fireEvent.click(screen.getByTestId('billing-issues-yes'));
    fireEvent.click(screen.getByTestId('billing-issues-report'));
    expect(onReportBug).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(api.createPortalSession).not.toHaveBeenCalled();
  });

  it('closing the modal leaves them on the page without opening the portal', async () => {
    const api = await mockApi();
    mountAs(TRIAL_PROFILE);
    fireEvent.click(await screen.findByText('Manage Subscription'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    expect(api.createPortalSession).not.toHaveBeenCalled();
  });
});
