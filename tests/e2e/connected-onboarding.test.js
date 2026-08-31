/**
 * E2E: the six-step onboarding tour (splash -> account -> appearance -> free
 * -> premium -> cta).
 *
 * Every OTHER spec boots with `onboardingComplete` seeded true (wdio.conf.js
 * `beforeSession`, the same way wdio.screenshots.conf.js already seeds it) so
 * the tour never shows and 58 unrelated spec files don't pay for it. This is
 * the one spec that clears the flag and actually walks it.
 *
 * Accounts already exist in the e2e fixture (wdio.conf.js's MOCK_ACCOUNTS),
 * so the account step is skipped and the flow is splash -> appearance -> free
 * -> premium -> cta. That skip is asserted explicitly below (waiting straight
 * for `appearance-preview`) rather than walked past — replay without
 * re-entering credentials is a headline behaviour of this redesign
 * (src/components/onboarding/steps.js: onboardingSteps).
 */

import { waitForApp } from './helpers.js';

describe('onboarding', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
  });

  it('walks from the splash to the mailbox', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(false));
    await $('[data-testid="onboarding-splash"]').waitForExist({ timeout: 10000 });

    await $('[data-testid="onboarding-language-de"]').click();
    await $('[data-testid="onboarding-continue"]').click();

    // Accounts already exist in the e2e fixture, so the credentials step is
    // skipped and appearance is next.
    await $('[data-testid="appearance-preview"]').waitForExist({ timeout: 5000 });
    await $('[data-testid="appearance-layout-two-column"]').click();
    expect(await $('[data-testid="preview-pane-viewer"]').isExisting()).toBe(false);
    await $('[data-testid="onboarding-continue"]').click();

    await $('[data-testid="free-feature-vault"]').waitForExist({ timeout: 5000 });
    await $('[data-testid="onboarding-continue"]').click();

    await $('[data-testid="premium-tile-tracker-blocking"]').click();
    // Asset shipped AND cleared the CSP — a missing <img> makes this false, so
    // it cannot pass by absence.
    const painted = await browser.execute(() => {
      const img = document.querySelector('[data-testid="premium-shot"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    expect(painted).toBe(true);
    await $('[data-testid="onboarding-continue"]').click();

    await $('[data-testid="onboarding-skip"]').click();
    await $('[data-testid="sidebar"]').waitForExist({ timeout: 15000 });
  });
});
