/**
 * E2E Test: Backup Settings Tab
 *
 * Verifies backup tab navigation, premium gate (Coming Soon overlay),
 * premium-enabled backup controls, and settings tab navigation stability.
 */

import { waitForApp, openSettings, closeSettings } from './helpers.js';

describe('Backup Settings', function () {
  this.timeout(60000);

  before(async function () {
    await waitForApp();
  });

  after(async function () {
    await closeSettings();
  });

  it('should navigate to Backup tab', async function () {
    await openSettings();
    await browser.pause(300);

    const clicked = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Backup' && btn.offsetHeight > 0) {
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
      return text.includes('Backup') && (
        text.includes('Coming Soon') ||
        text.includes('Backup Schedule') ||
        text.includes('Backup Health') ||
        text.includes('Developer')
      );
    });
    expect(hasContent).toBe(true);
  });

  it('should show premium overlay when not paid', async function () {
    // Ensure we are on the Backup tab and use the Developer toggle to set isPaidUser to false
    await browser.execute(() => {
      // Click Backup tab first
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Backup' && btn.offsetHeight > 0) {
          btn.click();
          break;
        }
      }
    });
    await browser.pause(300);

    // Find and ensure isPaidUser is false via the Developer toggle
    await browser.execute(() => {
      // Look for the Developer section toggle — if it shows the toggle is ON, click to turn OFF
      const headings = document.querySelectorAll('h4');
      for (const h of headings) {
        if (h.textContent.includes('Developer')) {
          const section = h.closest('.bg-mail-surface') || h.parentElement;
          if (section) {
            const toggle = section.querySelector('.toggle-switch');
            if (toggle) {
              // Check if toggle is currently active (premium enabled)
              const isActive = toggle.classList.contains('active') ||
                toggle.getAttribute('aria-checked') === 'true' ||
                toggle.querySelector('.translate-x-5, .translate-x-4') !== null;
              if (isActive) {
                toggle.click(); // Turn OFF to show premium overlay
              }
            }
          }
        }
      }
    });
    await browser.pause(400);

    const hasOverlay = await browser.execute(() => {
      return document.body.innerText.includes('Coming Soon');
    });
    expect(hasOverlay).toBe(true);
  });

  it('should show backup settings when premium enabled', async function () {
    // Enable premium via the Developer toggle
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
                toggle.click(); // Turn ON to show backup controls
              }
            }
          }
        }
      }
    });
    await browser.pause(400);

    const hasScheduleControls = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('Daily') || text.includes('Weekly') ||
        text.includes('Backup Schedule') || text.includes('Schedule');
    });
    expect(hasScheduleControls).toBe(true);
  });

  it('should navigate to all settings tabs without errors', async function () {
    const tabs = ['Accounts', 'Storage', 'Backup', 'Migration', 'Security', 'Appearance'];

    for (const tabName of tabs) {
      const clicked = await browser.execute((name) => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === name && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      }, tabName);

      expect(clicked).toBe(true);
      await browser.pause(300);

      // Verify no error overlay appeared
      const hasError = await browser.execute(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('something went wrong') ||
          text.includes('error boundary') ||
          text.includes('unexpected error');
      });
      expect(hasError).toBe(false);
    }
  });
});
