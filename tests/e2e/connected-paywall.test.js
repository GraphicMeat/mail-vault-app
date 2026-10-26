/**
 * E2E: the onboarding paywall.
 *
 * The thank-you step now sells: two plans, yearly preselected, one button that
 * opens the checkout. Billing is mocked at `window.fetch` (see mockBilling.js),
 * so what runs here is the shipped path: UpgradeCta -> startCheckout ->
 * billingApi -> fetch. When billing cannot answer, the old See Premium hand-off
 * has to stay, or the screen has a dead end.
 */

import { waitForApp } from './helpers.js';
import {
  installMockBilling, setBillingPlans, setBillingFault, checkoutCalls, seedSignedOut,
} from './mockBilling.js';

const PLANS = [
  { planId: 'monthly', interval: 'month', currency: 'eur', amount: 400, formattedAmount: '€4', trialDays: 0, trialEligible: true },
  { planId: 'yearly', interval: 'year', currency: 'eur', amount: 2500, formattedAmount: '€25', monthlyEquivalent: '€2',
    savingsPercent: 48, trialDays: 14, trialEligible: true },
];

/** Replay the tour from its thank-you step, the way a resumed tour does. */
async function openThankYou() {
  await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(true));
  await $('[data-testid="sidebar"]').waitForExist({ timeout: 15000 });
  await browser.execute(() => {
    window.__SETTINGS_STORE__.setState({ onboardingSkippedAt: 'cta' });
    window.__SETTINGS_STORE__.getState().setOnboardingComplete(false);
  });
  await $('[data-testid="onboarding-cta"]').waitForExist({ timeout: 10000 });
}

describe('Onboarding paywall', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await installMockBilling();
    await seedSignedOut();
    // The checkout URL is a scheme the shell refuses; openInBrowser then falls
    // back to window.open, which must not open a window on the runner.
    await browser.execute(() => { window.open = () => ({}); });
  });

  afterEach(async function () {
    await setBillingFault(null);
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(true));
  });

  it('shows both plans with yearly preselected and starts its trial', async function () {
    await setBillingPlans(PLANS);
    await openThankYou();
    await $('[data-testid="onboarding-plans"]').waitForExist({ timeout: 15000 });

    const checked = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="onboarding-plans"] input[type="radio"]')]
        .map((r) => ({ value: r.value, checked: r.checked })));
    expect(checked).toEqual([{ value: 'yearly', checked: true }, { value: 'monthly', checked: false }]);
    expect(await $('[data-testid="onboarding-checkout"]').getText()).toMatch(/free trial/i);

    await $('[data-testid="onboarding-checkout"]').click();
    await browser.waitUntil(async () => (await checkoutCalls()).length === 1, {
      timeout: 15000, timeoutMsg: 'no checkout session was requested',
    });
    const [call] = await checkoutCalls();
    expect(call.planId).toBe('yearly');
    expect(call.email).toBe(browser.mockAccounts[0].email.toLowerCase());

    // Onboarding is over and the user lands on Billing for the status check.
    await $('[data-testid="settings-page"]').waitForExist({ timeout: 15000 });
    expect(await browser.execute(() => window.__SETTINGS_STORE__.getState().onboardingComplete)).toBe(true);
  });

  it('keeps the See Premium hand-off when billing cannot answer', async function () {
    await setBillingPlans([]);
    await openThankYou();
    await $('[data-testid="onboarding-upgrade"]').waitForExist({ timeout: 15000 });
    expect(await $('[data-testid="onboarding-plans"]').isExisting()).toBe(false);
    expect(await $('[data-testid="onboarding-checkout"]').isExisting()).toBe(false);
  });
});
