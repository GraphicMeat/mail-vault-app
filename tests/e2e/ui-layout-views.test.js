/**
 * E2E Test: Layout Modes, View Styles, and Email List Styles (UI-only)
 *
 * Verifies switching between layout modes, view styles, and email list
 * styles via the Settings UI:
 * - Layout: Three Columns / Two Columns
 * - View Style: List View / Chat View
 * - Email List Style: Default / Compact
 */

import { waitForApp, openSettings, closeSettings, pressKey } from './helpers.js';

/**
 * Close settings with Escape key fallback for WKWebView reliability.
 */
async function closeSettingsReliable() {
  await pressKey('Escape');
  await browser.pause(300);

  const stillOpen = await browser.execute(() => {
    const el = document.querySelector('[data-testid="settings-page"]') ||
      document.querySelector('[class*="settings"], [class*="Settings"]');
    return el !== null && el.offsetHeight > 0;
  });

  if (stillOpen) {
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
    });
    await browser.pause(300);
  }
}

/**
 * Click a settings option button by its exact text content.
 * Scrolls the button into view first to handle off-screen elements.
 * @param {string} buttonText - The visible text of the button to click
 * @returns {boolean} - Whether the button was found and clicked
 */
async function clickSettingsButton(buttonText) {
  const clicked = await browser.execute((text) => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === text && btn.offsetHeight > 0) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
        return true;
      }
    }
    return false;
  }, buttonText);
  await browser.pause(300);
  return clicked;
}

/**
 * Check if a settings button has the active/selected state (border-mail-accent class).
 * @param {string} buttonText - The visible text of the button to check
 * @returns {boolean}
 */
async function isButtonActive(buttonText) {
  return browser.execute((text) => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === text && btn.offsetHeight > 0) {
        return btn.className.includes('border-mail-accent');
      }
    }
    return false;
  }, buttonText);
}

describe('Layout, View & List Style Switching', function () {
  this.timeout(30000);

  before(async function () {
    await waitForApp();
  });

  // -----------------------------------------------------------------------
  // Layout Mode Switching
  // -----------------------------------------------------------------------
  describe('Layout Mode Switching', function () {
    it('should switch to 2-column layout', async function () {
      await openSettings();
      await browser.pause(300);

      const clicked = await clickSettingsButton('Two Columns');
      expect(clicked).toBe(true);

      await closeSettingsReliable();

      // Verify the main content area uses flex-col (2-column layout)
      const usesFlexCol = await browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return false;
        // The main content area is a sibling of the sidebar
        const parent = sidebar.parentElement;
        if (!parent) return false;
        const children = Array.from(parent.children);
        for (const child of children) {
          if (child !== sidebar && child.offsetHeight > 0) {
            return child.className.includes('flex-col');
          }
        }
        return false;
      });
      expect(usesFlexCol).toBe(true);
    });

    it('should switch back to 3-column layout', async function () {
      await openSettings();
      await browser.pause(300);

      const clicked = await clickSettingsButton('Three Columns');
      expect(clicked).toBe(true);

      await closeSettingsReliable();

      // Verify the main content area uses flex-row (3-column layout)
      const usesFlexRow = await browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return false;
        const parent = sidebar.parentElement;
        if (!parent) return false;
        const children = Array.from(parent.children);
        for (const child of children) {
          if (child !== sidebar && child.offsetHeight > 0) {
            return child.className.includes('flex-row');
          }
        }
        return false;
      });
      expect(usesFlexRow).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // View Style Switching
  // -----------------------------------------------------------------------
  describe('View Style Switching', function () {
    it('should switch to Chat view', async function () {
      await openSettings();
      await browser.pause(300);

      const clicked = await clickSettingsButton('Chat View');
      expect(clicked).toBe(true);

      // Verify the Chat View button is now active
      const isActive = await isButtonActive('Chat View');
      expect(isActive).toBe(true);

      await closeSettingsReliable();
    });

    it('should switch back to List view', async function () {
      await openSettings();
      await browser.pause(300);

      const clicked = await clickSettingsButton('List View');
      expect(clicked).toBe(true);

      // Verify the List View button is now active
      const isActive = await isButtonActive('List View');
      expect(isActive).toBe(true);

      await closeSettingsReliable();
    });
  });

  // -----------------------------------------------------------------------
  // Email List Style Switching
  // -----------------------------------------------------------------------
  describe('Email List Style Switching', function () {
    it('should switch to Compact style', async function () {
      await openSettings();
      await browser.pause(300);

      // Scroll down to find the Compact button (it may be off-screen)
      await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Compact') {
            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
            return true;
          }
        }
        return false;
      });
      await browser.pause(200);

      const clicked = await clickSettingsButton('Compact');
      expect(clicked).toBe(true);

      // Verify the Compact button is now active
      const isActive = await isButtonActive('Compact');
      expect(isActive).toBe(true);

      await closeSettingsReliable();
    });

    it('should switch back to Default style', async function () {
      await openSettings();
      await browser.pause(300);

      // Scroll down to find the Default button
      await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Default') {
            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
            return true;
          }
        }
        return false;
      });
      await browser.pause(200);

      const clicked = await clickSettingsButton('Default');
      expect(clicked).toBe(true);

      // Verify the Default button is now active
      const isActive = await isButtonActive('Default');
      expect(isActive).toBe(true);

      await closeSettingsReliable();
    });
  });
});
