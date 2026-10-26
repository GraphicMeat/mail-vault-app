// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useMailStore } from '../../../stores/mailStore';
import { setLocale, t } from '../../../i18n/index.js';

// The thank-you step itself is under test, so only the steps before it are stubbed.
vi.mock('../Splash', () => ({ Splash: () => null }));
vi.mock('../StorageStep', () => ({ StorageStep: () => null }));
vi.mock('../AccountStep', () => ({ AccountStep: () => null }));
vi.mock('../AppearanceStep', () => ({ AppearanceStep: () => null }));
vi.mock('../DefaultMailStep', () => ({ DefaultMailStep: () => null }));
vi.mock('../FreeFeatures', () => ({ FreeFeatures: () => null }));
vi.mock('../PremiumGallery', () => ({ PremiumGallery: () => null }));

const flags = vi.hoisted(() => ({ appStore: false }));
vi.mock('../../../utils/buildFlags', () => ({
  get IS_APPSTORE_BUILD() { return flags.appStore; },
  IAP_PRODUCT_BACKUPS: 'com.mailvault.app.backups',
}));
vi.mock('../../../services/billingApi', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPricing: vi.fn(),
  openInBrowser: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../services/checkout', () => ({ startCheckout: vi.fn() }));
vi.mock('../../../data/reviews.js', () => ({
  REVIEWS: [{ id: 'r1', quote: 'Keeps my copy of everything.', author: 'Ana', source: 'AlternativeTo', url: 'https://alternativeto.net/software/mailvault/about/' }],
}));

const { fetchPricing, openInBrowser } = await import('../../../services/billingApi');
const { startCheckout } = await import('../../../services/checkout');
const { Onboarding } = await import('../../Onboarding');
const { UpgradeCta } = await import('../UpgradeCta');

const ACCOUNT = { id: 'a1', email: 'first@example.com' };
const PRICING = {
  currency: 'usd',
  plans: [
    { planId: 'monthly', interval: 'month', amount: 400, formattedAmount: '$4', trialDays: 0, trialEligible: true },
    { planId: 'yearly', interval: 'year', amount: 2500, formattedAmount: '$25', monthlyEquivalent: '$2', savingsPercent: 48, trialDays: 14, trialEligible: true },
  ],
};
const SUBSCRIBER = { premiumAccess: true, status: 'active', hasSubscription: true };

// A replay (accounts present) resumed at the thank-you step.
function renderCta({ accounts = [ACCOUNT], billingProfile = null } = {}) {
  useMailStore.setState({ accounts });
  useSettingsStore.setState({ onboardingSkippedAt: 'cta', billingProfile });
  const onComplete = vi.fn();
  render(<Onboarding onComplete={onComplete} />);
  return onComplete;
}

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  await setLocale('en');
  flags.appStore = false;
  fetchPricing.mockReset();
  fetchPricing.mockResolvedValue(PRICING);
  openInBrowser.mockClear();
  startCheckout.mockReset();
  startCheckout.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); useMailStore.setState({ accounts: [] }); });

describe('onboarding thank-you', () => {
  it('centres the thank-you in its own step class', () => {
    renderCta();
    expect(document.querySelector('.onboarding-step.onboarding-step-cta')).toBeTruthy();
  });

  it('when the plans cannot load, See Premium asks for Billing before the arrival and Continue with Free does not', async () => {
    fetchPricing.mockRejectedValue(new Error('pricing_unavailable'));
    const onComplete = renderCta();
    fireEvent.click(await screen.findByTestId('onboarding-upgrade'));
    expect(onComplete).toHaveBeenCalledWith({ openBilling: true });
    expect(useSettingsStore.getState().onboardingComplete).toBe(true);
    cleanup();

    const onFree = renderCta();
    fireEvent.click(await screen.findByTestId('onboarding-skip'));
    expect(onFree).toHaveBeenCalledWith({ openBilling: false });
  });

  it('Continue with Free stays the same button when the plans settle, so a click never lands on See Premium', async () => {
    let fail;
    fetchPricing.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const onComplete = renderCta();
    const skip = await screen.findByTestId('onboarding-skip');
    fail(new Error('pricing_unavailable'));
    await screen.findByTestId('onboarding-upgrade');
    expect(skip.isConnected).toBe(true);
    expect(skip.dataset.testid).toBe('onboarding-skip');
    fireEvent.click(skip);
    expect(onComplete).toHaveBeenCalledWith({ openBilling: false });
  });

  it('a subscriber gets a single Continue, no plans, no reviews and no pricing request', () => {
    const onComplete = renderCta({ billingProfile: SUBSCRIBER });
    expect(screen.queryByTestId('onboarding-upgrade')).toBeNull();
    expect(screen.queryByTestId('onboarding-plans')).toBeNull();
    expect(screen.queryByTestId('onboarding-reviews')).toBeNull();
    const only = screen.getByTestId('onboarding-skip');
    expect(only.textContent).toBe(t('common.continue'));
    fireEvent.click(only);
    expect(onComplete).toHaveBeenCalledWith({ openBilling: false });
    expect(fetchPricing).not.toHaveBeenCalled();
  });

  it('with no account there is nothing to buy with: a single Continue and no pricing request', () => {
    renderCta({ accounts: [] });
    expect(screen.queryByTestId('onboarding-upgrade')).toBeNull();
    expect(screen.queryByTestId('onboarding-plans')).toBeNull();
    expect(screen.getByTestId('onboarding-skip').textContent).toBe(t('common.continue'));
    expect(fetchPricing).not.toHaveBeenCalled();
  });
});

describe('onboarding paywall', () => {
  it('asks for prices on the first account address and shows yearly preselected', async () => {
    renderCta();
    const plans = await screen.findByTestId('onboarding-plans');
    expect(fetchPricing).toHaveBeenCalledWith(expect.objectContaining({ email: 'first@example.com' }));
    const radios = within(plans).getAllByRole('radio');
    expect(radios.map(r => r.value)).toEqual(['yearly', 'monthly']);
    expect(radios[0].checked).toBe(true);
    expect(screen.getByTestId('onboarding-checkout').textContent).toBe(t('settings.billing.startFreeTrial'));
  });

  it('starts checkout for the chosen plan and then lands on Billing for the status check', async () => {
    const onComplete = renderCta();
    await screen.findByTestId('onboarding-plans');
    fireEvent.click(screen.getByTestId('onboarding-checkout'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ openBilling: true }));
    expect(startCheckout).toHaveBeenCalledWith({ email: 'first@example.com', planId: 'yearly' });
    expect(useSettingsStore.getState().onboardingComplete).toBe(true);
  });

  it('follows the plan the user picks, and upgrades instead of starting a trial on monthly', async () => {
    const onComplete = renderCta();
    await screen.findByTestId('onboarding-plans');
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(t('settings.billing.monthly')) }));
    expect(screen.getByTestId('onboarding-checkout').textContent).toBe(t('common.upgrade'));
    fireEvent.click(screen.getByTestId('onboarding-checkout'));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(startCheckout).toHaveBeenCalledWith({ email: 'first@example.com', planId: 'monthly' });
  });

  it('a checkout that fails says so and keeps the user here', async () => {
    startCheckout.mockResolvedValue({ ok: false, error: 'Could not start checkout.' });
    const onComplete = renderCta();
    await screen.findByTestId('onboarding-plans');
    fireEvent.click(screen.getByTestId('onboarding-checkout'));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not start checkout.');
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-checkout').disabled).toBe(false);
  });

  it('puts a bare API code into words', async () => {
    startCheckout.mockResolvedValue({ ok: false, error: 'billing_unavailable' });
    renderCta();
    await screen.findByTestId('onboarding-plans');
    fireEvent.click(screen.getByTestId('onboarding-checkout'));
    expect((await screen.findByRole('alert')).textContent)
      .toBe(t('settings.billing.billingServiceTemporarilyUnavailable'));
  });

  it('does not start a second checkout while the first is opening', async () => {
    let finish;
    startCheckout.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderCta();
    await screen.findByTestId('onboarding-plans');
    fireEvent.click(screen.getByTestId('onboarding-checkout'));
    fireEvent.click(screen.getByTestId('onboarding-checkout'));
    expect(startCheckout).toHaveBeenCalledTimes(1);
    finish({ ok: true });
  });

  it('Continue with Free and Already subscribed both stay on offer beside the plans', async () => {
    const onComplete = renderCta();
    await screen.findByTestId('onboarding-plans');
    expect(screen.getByTestId('onboarding-skip').textContent).toBe(t('onboarding.ctaSkip'));
    fireEvent.click(screen.getByTestId('onboarding-restore'));
    expect(onComplete).toHaveBeenCalledWith({ openBilling: true });
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it('names what Premium does in three concrete lines', async () => {
    renderCta();
    await screen.findByTestId('onboarding-plans');
    const impact = screen.getByTestId('onboarding-impact');
    expect(within(impact).getAllByRole('listitem')).toHaveLength(3);
    expect(within(impact).getByText(t('premium.backupSchedule.title'))).toBeTruthy();
  });

  it('shows the reviews with their links to sellers only', async () => {
    renderCta();
    await screen.findByTestId('onboarding-plans');
    const reviews = screen.getByTestId('onboarding-reviews');
    expect(within(reviews).getByText(/Keeps my copy/)).toBeTruthy();
    expect(within(reviews).getByTestId('onboarding-review-link').getAttribute('href'))
      .toBe('https://alternativeto.net/software/mailvault/about/');
  });

  it('opens the terms and the privacy policy in the system browser', async () => {
    renderCta();
    await screen.findByTestId('onboarding-plans');
    fireEvent.click(screen.getByTestId('onboarding-terms'));
    fireEvent.click(screen.getByTestId('onboarding-privacy'));
    expect(openInBrowser.mock.calls.map(c => c[0])).toEqual([
      'https://mailvaultapp.com/terms.html',
      'https://mailvaultapp.com/privacy.html',
    ]);
  });
});

describe('onboarding paywall in the App Store build', () => {
  it('shows the proof and the old two buttons, and never asks for a price', async () => {
    flags.appStore = true;
    const onComplete = renderCta();
    expect(screen.getByTestId('onboarding-reviews')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-plans')).toBeNull();
    expect(screen.queryByTestId('onboarding-checkout')).toBeNull();
    expect(screen.queryByTestId('onboarding-restore')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-upgrade'));
    expect(onComplete).toHaveBeenCalledWith({ openBilling: true });
    expect(fetchPricing).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });
});

describe('UpgradeCta without an upgrade', () => {
  it('shows only Continue', () => {
    const onSkip = vi.fn();
    render(<UpgradeCta onSkip={onSkip} onOpenFaq={() => {}} />);
    expect(screen.queryByTestId('onboarding-upgrade')).toBeNull();
    expect(screen.getAllByRole('button').filter(b => b.dataset.testid?.startsWith('onboarding-'))
      .map(b => b.dataset.testid)).toEqual(['onboarding-skip', 'onboarding-faq']);
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
