/**
 * E2E Visual Regression: Settings Tabs
 *
 * Captures baseline screenshots of all 6 settings tabs:
 * Accounts, Storage, Backup, Migration, Security, Appearance.
 *
 * Uses freezeDynamicContent() before every screenshot to mask
 * timestamps, avatars, and animations that cause false positives.
 */

import { waitForApp, openSettings, closeSettings } from './helpers.js';

/**
 * Freeze dynamic content before screenshots to prevent false positives.
 * Hides timestamps, avatars, and stops animations.
 */
async function freezeDynamicContent() {
  await browser.execute(() => {
    // Freeze timestamps/dates to static text
    document.querySelectorAll('[data-testid="email-date"], .email-date, time').forEach(el => {
      el.textContent = '2026-01-01';
      el.style.visibility = 'hidden';
    });
    // Hide avatar images that may load dynamically
    document.querySelectorAll('.avatar, [data-testid="avatar"]').forEach(el => {
      el.style.visibility = 'hidden';
    });
    // Freeze any loading spinners
    document.querySelectorAll('.animate-spin, .loading').forEach(el => {
      el.style.animation = 'none';
    });
    // Freeze relative time displays
    document.querySelectorAll('[data-testid="relative-time"]').forEach(el => {
      el.textContent = 'Jan 1';
      el.style.visibility = 'hidden';
    });
    // Stop any CSS transitions mid-flight
    document.querySelectorAll('*').forEach(el => {
      el.style.transition = 'none';
    });
  });
}

/**
 * Click a settings tab by its visible text label.
 */
async function clickSettingsTab(tabName) {
  await browser.execute((name) => {
    const tabs = document.querySelectorAll('button');
    for (const t of tabs) {
      if (t.textContent.trim() === name && t.offsetHeight > 0) {
        t.click();
        break;
      }
    }
  }, tabName);
  await browser.pause(500);
}

/**
 * Set isPaidUser flag via browser.execute to show full premium content.
 */
async function setIsPaidUser(value) {
  await browser.execute((isPaid) => {
    // Find the Developer toggle in the Backup tab to set isPaidUser
    // Or set it directly if accessible via store
    const buttons = document.querySelectorAll('button, input[type="checkbox"], [role="switch"]');
    for (const el of buttons) {
      const label = el.closest('label') || el.parentElement;
      if (label) {
        const text = (label.textContent || '').toLowerCase();
        if (text.includes('developer') || text.includes('paid user') || text.includes('premium')) {
          if (isPaid && !el.checked) {
            el.click();
          } else if (!isPaid && el.checked) {
            el.click();
          }
          return true;
        }
      }
    }
    // Fallback: try to find a developer toggle by walking all toggle-like elements
    const toggles = document.querySelectorAll('.toggle-switch, [role="switch"]');
    for (const toggle of toggles) {
      const container = toggle.closest('.flex') || toggle.parentElement;
      if (container) {
        const text = (container.textContent || '').toLowerCase();
        if (text.includes('developer') || text.includes('paid') || text.includes('premium')) {
          toggle.click();
          return true;
        }
      }
    }
    return false;
  }, value);
  await browser.pause(300);
}

const SETTINGS_TABS = ['Accounts', 'Storage', 'Backup', 'Migration', 'Security', 'Appearance'];
const PREMIUM_TABS = ['Backup', 'Migration'];

describe('Visual Regression — Settings Tabs', function () {
  this.timeout(120000);

  let settingsOpened = false;

  before(async function () {
    await waitForApp();
  });

  after(async function () {
    await closeSettings();
  });

  for (const tabName of SETTINGS_TABS) {
    it(`settings - ${tabName.toLowerCase()} tab matches baseline`, async function () {
      if (!settingsOpened) {
        await openSettings();
        settingsOpened = true;
        await browser.pause(500);
      }

      await clickSettingsTab(tabName);

      // For premium tabs, enable isPaidUser to see full content
      if (PREMIUM_TABS.includes(tabName)) {
        await setIsPaidUser(true);
        await browser.pause(300);
      }

      await freezeDynamicContent();
      const result = await browser.checkScreen(`settings-${tabName.toLowerCase()}`, { misMatchPercentage: 0.5 });
      expect(result).toBeLessThanOrEqual(0.5);

      // Reset isPaidUser for premium tabs
      if (PREMIUM_TABS.includes(tabName)) {
        await setIsPaidUser(false);
      }
    });
  }
});
