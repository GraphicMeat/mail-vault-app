/**
 * E2E Test: Migration Wizard Settings Tab
 *
 * Premium state comes from the billing profile now — the old Developer toggle
 * that flipped isPaidUser is gone, and the dev override only works against the
 * Vite dev server. A test HOME has no subscription, so this covers the
 * unpaid path: the settings page is the "Premium Feature" gate and nothing
 * of the wizard (its steps, its history) is mounted behind it.
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

describe('Migration Wizard', function () {
  this.timeout(60000);

  before(async function () {
    await waitForApp();
    await openSettings();
    await browser.pause(300);
    await clickSettingsNav('Migration');
  });

  after(async function () {
    await closeSettings();
  });

  it('should navigate to Migration tab', async function () {
    const hasContent = await browser.execute(() =>
      document.body.innerText.includes('Migration'));
    expect(hasContent).toBe(true);
  });

  it('should show the premium overlay for an unsubscribed profile', async function () {
    const hasOverlay = await browser.execute(() =>
      document.body.innerText.includes('Premium Feature'));
    expect(hasOverlay).toBe(true);
  });

  it('should mount none of the wizard behind the gate', async function () {
    const page = await browser.execute(() => {
      const text = document.body.innerText;
      return {
        gate: !!document.querySelector('.settings-feature-gate'),
        steps: text.includes('Source') && text.includes('Destination'),
        history: text.includes('Migration History'),
      };
    });
    expect(page).toEqual({ gate: true, steps: false, history: false });
  });
});
