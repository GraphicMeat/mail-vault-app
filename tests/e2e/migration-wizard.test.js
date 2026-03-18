/**
 * E2E Test: Migration Wizard Settings Tab
 *
 * Verifies migration tab navigation, premium gate (Coming Soon overlay),
 * premium-enabled wizard UI elements, and migration history section.
 */

import { waitForApp, openSettings, closeSettings } from './helpers.js';

describe('Migration Wizard', function () {
  this.timeout(60000);

  before(async function () {
    await waitForApp();
  });

  after(async function () {
    // Restore isPaidUser to false before closing (clean state)
    await browser.execute(() => {
      // Navigate to Backup tab to find the Developer toggle
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Backup' && btn.offsetHeight > 0) {
          btn.click();
          break;
        }
      }
    });
    await browser.pause(300);
    await browser.execute(() => {
      const headings = document.querySelectorAll('h4');
      for (const h of headings) {
        if (h.textContent.includes('Developer')) {
          const section = h.closest('.bg-mail-surface') || h.parentElement;
          if (section) {
            const toggle = section.querySelector('.toggle-switch');
            if (toggle) {
              const isActive = toggle.classList.contains('active') ||
                toggle.getAttribute('aria-checked') === 'true' ||
                toggle.querySelector('.translate-x-5, .translate-x-4') !== null;
              if (isActive) {
                toggle.click(); // Turn OFF
              }
            }
          }
        }
      }
    });
    await browser.pause(200);
    await closeSettings();
  });

  it('should navigate to Migration tab', async function () {
    await openSettings();
    await browser.pause(300);

    const clicked = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Migration' && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    expect(clicked).toBe(true);
    await browser.pause(400);

    const hasContent = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('Migration');
    });
    expect(hasContent).toBe(true);
  });

  it('should show premium overlay for migration when not paid', async function () {
    // Ensure isPaidUser is false via the Backup tab Developer toggle
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Backup' && btn.offsetHeight > 0) {
          btn.click();
          break;
        }
      }
    });
    await browser.pause(300);

    await browser.execute(() => {
      const headings = document.querySelectorAll('h4');
      for (const h of headings) {
        if (h.textContent.includes('Developer')) {
          const section = h.closest('.bg-mail-surface') || h.parentElement;
          if (section) {
            const toggle = section.querySelector('.toggle-switch');
            if (toggle) {
              const isActive = toggle.classList.contains('active') ||
                toggle.getAttribute('aria-checked') === 'true' ||
                toggle.querySelector('.translate-x-5, .translate-x-4') !== null;
              if (isActive) {
                toggle.click(); // Turn OFF
              }
            }
          }
        }
      }
    });
    await browser.pause(300);

    // Navigate to Migration tab
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Migration' && btn.offsetHeight > 0) {
          btn.click();
          break;
        }
      }
    });
    await browser.pause(400);

    const hasOverlay = await browser.execute(() => {
      return document.body.innerText.includes('Coming Soon');
    });
    expect(hasOverlay).toBe(true);
  });

  it('should show migration wizard when premium enabled', async function () {
    // Enable premium via Backup tab Developer toggle
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Backup' && btn.offsetHeight > 0) {
          btn.click();
          break;
        }
      }
    });
    await browser.pause(300);

    await browser.execute(() => {
      const headings = document.querySelectorAll('h4');
      for (const h of headings) {
        if (h.textContent.includes('Developer')) {
          const section = h.closest('.bg-mail-surface') || h.parentElement;
          if (section) {
            const toggle = section.querySelector('.toggle-switch');
            if (toggle) {
              const isActive = toggle.classList.contains('active') ||
                toggle.getAttribute('aria-checked') === 'true' ||
                toggle.querySelector('.translate-x-5, .translate-x-4') !== null;
              if (!isActive) {
                toggle.click(); // Turn ON
              }
            }
          }
        }
      }
    });
    await browser.pause(300);

    // Navigate to Migration tab
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Migration' && btn.offsetHeight > 0) {
          btn.click();
          break;
        }
      }
    });
    await browser.pause(400);

    const hasWizard = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('Source') || text.includes('Destination') ||
        text.includes('Start Migration') || text.includes('Next');
    });
    expect(hasWizard).toBe(true);
  });

  it('should show migration history section', async function () {
    // Should already be on Migration tab with premium enabled
    const hasHistory = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('Migration History') || text.includes('History');
    });
    expect(hasHistory).toBe(true);
  });
});
