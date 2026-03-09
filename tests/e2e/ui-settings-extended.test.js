/**
 * E2E Test: Settings Page — Extended Sections (UI-only)
 *
 * Covers settings tabs/sections not tested by ui-settings.test.js:
 * - General Tab: Appearance (theme, date format)
 * - General Tab: Layout & View Modes
 * - General Tab: Search & History
 * - General Tab: Notifications Details (badge count, mark-as-read mode)
 * - Accounts Tab (display name, signature, avatar color picker)
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

describe('Settings Page — Extended', function () {
  this.timeout(30000);

  before(async function () {
    await waitForApp();
  });

  // -----------------------------------------------------------------------
  // General Tab — Appearance
  // -----------------------------------------------------------------------
  describe('General Tab — Appearance', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
    });

    after(async function () {
      await closeSettingsReliable();
    });

    it('should have the theme toggle (light/dark)', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText;
        return text.includes('Theme') || text.includes('theme') ||
               text.includes('Light') || text.includes('Dark');
      });
      expect(found).toBe(true);
    });

    it('should have the date format dropdown', async function () {
      const options = await browser.execute(() => {
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const opts = Array.from(select.options).map(o => o.value);
          if (opts.includes('auto') && opts.includes('MM/dd/yyyy')) {
            return opts;
          }
        }
        return null;
      });
      expect(options).not.toBe(null);
      expect(options).toContain('auto');
      expect(options).toContain('MM/dd/yyyy');
      expect(options).toContain('dd/MM/yyyy');
      expect(options).toContain('yyyy-MM-dd');
      expect(options).toContain('dd MMM yyyy');
      expect(options).toContain('custom');
    });

    it('should show custom format input when "custom" is selected, then restore to "auto"', async function () {
      // Select "custom" from the date format dropdown
      await browser.execute(() => {
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const opts = Array.from(select.options).map(o => o.value);
          if (opts.includes('auto') && opts.includes('custom')) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype, 'value'
            ).set;
            nativeSetter.call(select, 'custom');
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      await browser.pause(300);

      // Check that a custom format input with expected placeholder appears
      const hasCustomInput = await browser.execute(() => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          const placeholder = input.getAttribute('placeholder') || '';
          if (placeholder.includes('dd.MM.yyyy') || placeholder.includes('e.g.')) {
            return input.offsetHeight > 0;
          }
        }
        return false;
      });
      expect(hasCustomInput).toBe(true);

      // Restore to "auto"
      await browser.execute(() => {
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const opts = Array.from(select.options).map(o => o.value);
          if (opts.includes('auto') && opts.includes('custom')) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype, 'value'
            ).set;
            nativeSetter.call(select, 'auto');
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      await browser.pause(300);
    });
  });

  // -----------------------------------------------------------------------
  // General Tab — Layout & View Modes
  // -----------------------------------------------------------------------
  describe('General Tab — Layout & View Modes', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
    });

    after(async function () {
      await closeSettingsReliable();
    });

    it('should have layout mode options (3-Column and 2-Column)', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText;
        return text.includes('3-Column') && text.includes('2-Column');
      });
      expect(found).toBe(true);
    });

    it('should have view style options (List and Chat)', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText;
        return text.includes('List') && text.includes('Chat');
      });
      expect(found).toBe(true);
    });

    it('should have email list style options (Default and Compact)', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText;
        return text.includes('Default') && text.includes('Compact');
      });
      expect(found).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // General Tab — Search & History
  // -----------------------------------------------------------------------
  describe('General Tab — Search & History', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
      // Scroll down to find Search & History section
      await browser.execute(() => {
        const allText = document.querySelectorAll('h4, h3, div');
        for (const el of allText) {
          const text = (el.textContent || '').trim();
          if (text.includes('Search') && text.includes('History')) {
            el.scrollIntoView({ behavior: 'instant' });
            return true;
          }
        }
        // Fallback: scroll the settings content area to the bottom
        const settingsContent = document.querySelector('[data-testid="settings-page"]') ||
          document.querySelector('[class*="settings-content"], [class*="overflow-y-auto"]');
        if (settingsContent) {
          settingsContent.scrollTop = settingsContent.scrollHeight;
        }
        return false;
      });
      await browser.pause(300);
    });

    after(async function () {
      await closeSettingsReliable();
    });

    it('should have search history limit slider', async function () {
      const found = await browser.execute(() => {
        const ranges = document.querySelectorAll('input[type="range"]');
        return ranges.length > 0;
      });
      expect(found).toBe(true);
    });

    it('should have clear search history button', async function () {
      const found = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('clear') && text.includes('search')) {
            return true;
          }
        }
        return false;
      });
      expect(found).toBe(true);
    });

    it('should have filter history section with clear button', async function () {
      const found = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('clear') && text.includes('filter')) {
            return true;
          }
        }
        return false;
      });
      expect(found).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // General Tab — Notifications Details
  // -----------------------------------------------------------------------
  describe('General Tab — Notifications Details', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
      // Scroll to notifications section
      await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-notifications"]');
        if (section) {
          section.scrollIntoView({ behavior: 'instant' });
          return true;
        }
        return false;
      });
      await browser.pause(300);
    });

    after(async function () {
      await closeSettingsReliable();
    });

    it('should have badge count toggle', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('badge');
      });
      expect(found).toBe(true);
    });

    it('should have mark as read mode dropdown', async function () {
      const options = await browser.execute(() => {
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const opts = Array.from(select.options).map(o => o.value);
          if (opts.includes('auto') && opts.includes('manual')) {
            return opts;
          }
        }
        return null;
      });
      expect(options).not.toBe(null);
      expect(options).toContain('auto');
      expect(options).toContain('manual');
    });
  });

  // -----------------------------------------------------------------------
  // Accounts Tab
  // -----------------------------------------------------------------------
  describe('Accounts Tab', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
      // Switch to the Accounts tab
      await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Accounts') {
            btn.click();
            return true;
          }
        }
        return false;
      });
      await browser.pause(400);
    });

    after(async function () {
      await closeSettingsReliable();
    });

    it('should show the Accounts tab content', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText;
        return text.includes('@') || text.includes('Add Account');
      });
      expect(found).toBe(true);
    });

    it('should have display name input', async function () {
      // Click first account to open its settings (if account list is shown)
      await browser.execute(() => {
        const items = document.querySelectorAll('[class*="account"], [data-testid*="account"]');
        for (const item of items) {
          if (item.textContent.includes('@')) {
            item.click();
            return true;
          }
        }
        // Fallback: click any element containing an email address in the accounts area
        const allEls = document.querySelectorAll('div, span, button');
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (text.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) && el.offsetHeight > 0) {
            el.click();
            return true;
          }
        }
        return false;
      });
      await browser.pause(400);

      const found = await browser.execute(() => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          const placeholder = input.getAttribute('placeholder') || '';
          if (placeholder.includes('John Doe')) {
            return true;
          }
        }
        return false;
      });
      expect(found).toBe(true);
    });

    it('should have signature toggle', async function () {
      const found = await browser.execute(() => {
        const text = document.body.innerText;
        return text.includes('Enable Signature') || text.includes('Signature');
      });
      expect(found).toBe(true);
    });

    it('should have avatar color picker with 5+ color buttons', async function () {
      const colorCount = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        let count = 0;
        for (const btn of buttons) {
          if (btn.classList.contains('rounded-full') &&
              btn.offsetHeight >= 20 && btn.offsetHeight <= 40 &&
              (btn.style.backgroundColor || window.getComputedStyle(btn).backgroundColor !== 'rgba(0, 0, 0, 0)')) {
            count++;
          }
        }
        return count;
      });
      expect(colorCount).toBeGreaterThanOrEqual(5);
    });
  });
});
