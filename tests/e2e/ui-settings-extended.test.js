/**
 * E2E Test: Settings Page — Extended Sections (UI-only)
 *
 * Covers settings tabs/sections not tested by ui-settings.test.js:
 * - Appearance: theme, date format
 * - Appearance > Layout: mail view, reading pane, message rows
 * - General Tab: Search & History
 * - General Tab: Notifications Details (badge count, mark-as-read mode)
 * - Accounts Tab (display name, signature, avatar color picker)
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav, pressKey } from './helpers.js';

/** Labels of the workspace segments rendered on the current settings page. */
const segmentLabels = () => browser.execute(() =>
  [...document.querySelectorAll('.settings-segments button')].map(btn => btn.textContent.trim()));

describe('Settings Page — Extended', function () {
  this.timeout(30000);

  let appState;
  before(async function () {
    appState = await waitForApp();
  });

  // -----------------------------------------------------------------------
  // Appearance
  // -----------------------------------------------------------------------
  describe('Appearance', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
      await openSettings();
      await clickSettingsNav('Appearance');
      await browser.pause(300);
    });

    after(async function () {
      await closeSettings();
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
      await clickSettingsNav('Date & time');
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
      await clickSettingsNav('Date & time');
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
  // Appearance - Layout
  // -----------------------------------------------------------------------
  describe('Appearance - Layout', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
      await openSettings();
      await clickSettingsNav('Appearance');
      await clickSettingsNav('Layout');
      await browser.pause(300);
    });

    after(async function () {
      await closeSettings();
    });

    it('should have reading pane options (beside and below the list)', async function () {
      const labels = await segmentLabels();
      expect(labels).toContain('Beside the list');
      expect(labels).toContain('Below the list');
    });

    it('should have mail view options (Email and Chat)', async function () {
      const labels = await segmentLabels();
      expect(labels).toContain('Email');
      expect(labels).toContain('Chat');
    });

    it('should have message row options (two lines and single line)', async function () {
      const labels = await segmentLabels();
      expect(labels).toContain('Two lines');
      expect(labels).toContain('Single line');
    });
  });

  // -----------------------------------------------------------------------
  // General Tab — Search & History
  // -----------------------------------------------------------------------
  describe('Behavior — Search & History', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
      await openSettings();
      await browser.pause(300);
      // Search/filter history moved to the General tab's Behavior sub-tab
      await clickSettingsNav('Behavior');
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
      await closeSettings();
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
        // The "Clear" button is inside a row container that also contains "Search history" text
        const rows = document.querySelectorAll('.flex.items-center.justify-between');
        for (const row of rows) {
          if (row.textContent.includes('Search history')) {
            const btn = row.querySelector('button');
            if (btn && btn.textContent.trim() === 'Clear') return true;
          }
        }
        return false;
      });
      expect(found).toBe(true);
    });

    it('should have filter history section with clear button', async function () {
      const found = await browser.execute(() => {
        // The "Clear" button is inside a row container that also contains "Filter history" text
        const rows = document.querySelectorAll('.flex.items-center.justify-between');
        for (const row of rows) {
          if (row.textContent.includes('Filter history')) {
            const btn = row.querySelector('button');
            if (btn && btn.textContent.trim() === 'Clear') return true;
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
  describe('Notifications & Behavior — details', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
      await openSettings();
      await browser.pause(300);
    });

    after(async function () {
      await closeSettings();
    });

    it('should have badge count toggle', async function () {
      // Badge settings live on the Notifications sub-tab
      await clickSettingsNav('Notifications');
      const found = await browser.execute(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('badge');
      });
      expect(found).toBe(true);
    });

    it('should have mark as read mode dropdown', async function () {
      // Mark as Read moved to the Behavior sub-tab
      await clickSettingsNav('Behavior');
      const options = await browser.execute(() => {
        // The date-format dropdown lives on the Appearance sub-tab, so it is
        // not mounted here — document scope is unambiguous.
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
      if (appState !== 'ready') this.skip();
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
      await closeSettings();
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
      // The avatar palette moved under the account's Advanced sub-tab
      await clickSettingsNav('Advanced');
      const colorCount = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        let count = 0;
        for (const btn of buttons) {
          // Avatar color buttons have: rounded-full class, title="#hexcolor", and inline backgroundColor
          const title = btn.getAttribute('title') || '';
          if (btn.classList.contains('rounded-full') && title.startsWith('#')) {
            count++;
          }
        }
        return count;
      });
      expect(colorCount).toBeGreaterThanOrEqual(5);
    });
  });
});
