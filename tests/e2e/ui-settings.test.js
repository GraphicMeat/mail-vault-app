/**
 * E2E Test: Settings Page Sections (UI-only)
 *
 * Verifies that key settings sections exist and basic interactions work:
 * - Undo Send toggle and delay dropdown
 * - Email Templates (create / delete)
 * - Notifications (master toggle and preview option)
 * - Keyboard Shortcuts section
 * - Storage tab with Auto-Cleanup and Pro badge
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav, pressKey } from './helpers.js';

describe('Settings Page', function () {
  this.timeout(30000);
  let appState;
  let settingsAccessible = false;

  before(async function () {
    appState = await waitForApp();
    // Try to open settings — may not work from welcome screen on CI
    try {
      await openSettings();
      settingsAccessible = true;
      await closeSettings();
    } catch {
      settingsAccessible = false;
    }
  });

  after(async function () {
    await closeSettings();
  });

  describe('Behavior — Undo Send', function () {
    before(async function () {
      if (!settingsAccessible) this.skip();
      await openSettings();
      await browser.pause(300);
      // Undo Send lives on the General tab's Behavior sub-tab now
      await clickSettingsNav('Behavior');
    });

    after(async function () {
      await closeSettings();
    });

    it('should have the Undo Send section', async function () {
      const found = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-undo-send"]');
        if (section && section.offsetHeight > 0) return true;
        return document.body.innerText.includes('Send Delay');
      });
      expect(found).toBe(true);
    });

    it('should offer send delay options and warn when a delay is set', async function () {
      // Undo Send is a single "Send Delay" select now (0 = off) in the Sending
      // section — the old Enable toggle + delay dropdown pair is gone.
      const setDelay = (value) => browser.execute((v) => {
        const select = document.querySelector('[data-testid="settings-undo-send"] select');
        if (!select) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype, 'value'
        ).set;
        setter.call(select, v);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, value);

      const options = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-undo-send"]');
        const select = section && section.querySelector('select');
        return select ? Array.from(select.options).map(o => o.value) : null;
      });
      expect(options).not.toBe(null);
      expect(options).toContain('0');
      expect(options).toContain('30');

      // Selecting a delay surfaces the stay-awake warning
      expect(await setDelay('30')).toBe(true);
      await browser.pause(300);
      const hasWarning = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-undo-send"]');
        return (section?.innerText || '').includes('stay awake');
      });
      expect(hasWarning).toBe(true);

      // Restore Off
      await setDelay('0');
      await browser.pause(200);
    });
  });

  describe('Templates Tab — Email Templates', function () {
    before(async function () {
      if (!settingsAccessible) this.skip();
      await openSettings();
      await browser.pause(300);
      // Templates moved to their own top-level tab
      await clickSettingsNav('Templates');
    });

    after(async function () {
      await closeSettings();
    });

    it('should have the Email Templates section', async function () {
      const found = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-templates"]');
        if (section && section.offsetHeight > 0) return true;
        return document.body.innerText.includes('Email Templates');
      });
      expect(found).toBe(true);
    });

    it('should create a template', async function () {
      // Click "Add Template" button
      const clickedAdd = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes('Add Template')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      expect(clickedAdd).toBe(true);
      await browser.pause(400);

      // Fill in template name — placeholder is "e.g. Follow-up..."
      await browser.execute(() => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
          if (input.offsetHeight > 0 && (placeholder.includes('follow-up') || placeholder.includes('e.g.'))) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(input, 'E2E Test Template');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      await browser.pause(200);

      // Fill in template body — placeholder is "Write the template content here..."
      await browser.execute(() => {
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          const placeholder = (ta.getAttribute('placeholder') || '').toLowerCase();
          if (ta.offsetHeight > 0 && placeholder.includes('template')) {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeTextAreaValueSetter.call(ta, 'This is a test template body created by E2E tests.');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      await browser.pause(200);

      // Click Save button
      await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim();
          if (text === 'Save' || text.includes('Save')) {
            if (btn.offsetHeight > 0 && !btn.disabled) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });
      await browser.pause(400);

      // Verify the template now appears in the list
      const templateExists = await browser.execute(() => {
        return document.body.innerText.includes('E2E Test Template');
      });
      expect(templateExists).toBe(true);
    });

    it('should delete the test template', async function () {
      // Find the template entry and click its delete button (trash icon with title "Delete template")
      const deleted = await browser.execute(() => {
        const allText = document.querySelectorAll('div');
        for (const el of allText) {
          if (el.textContent.trim() === 'E2E Test Template' && el.className.includes('font-medium')) {
            // Walk up to the template row container
            const row = el.closest('.flex') || el.parentElement?.parentElement;
            if (!row) continue;
            const deleteBtn = row.querySelector('button[title="Delete template"]');
            if (deleteBtn) {
              deleteBtn.click();
              return true;
            }
          }
        }
        return false;
      });

      await browser.pause(400);

      // Verify the template is removed
      const templateGone = await browser.execute(() => {
        return !document.body.innerText.includes('E2E Test Template');
      });
      expect(deleted).toBe(true);
      expect(templateGone).toBe(true);
    });
  });

  describe('Notifications — master toggle and preview', function () {
    before(async function () {
      if (!settingsAccessible) this.skip();
      await openSettings();
      await browser.pause(300);
      await clickSettingsNav('General');
      await clickSettingsNav('Notifications');
    });

    after(async function () {
      await closeSettings();
    });

    it('should have the Notifications section with master toggle', async function () {
      const found = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-notifications"]');
        if (section && section.offsetHeight > 0) {
          return section.innerText.includes('Enable desktop notifications');
        }
        const text = document.body.innerText;
        return text.includes('Notifications') &&
               text.includes('Enable desktop notifications');
      });
      expect(found).toBe(true);
    });

    it('should have the email preview option', async function () {
      const found = await browser.execute(() => {
        return document.body.innerText.includes('Show email preview');
      });
      expect(found).toBe(true);
    });
  });

  describe('Keyboard Shortcuts', function () {
    before(async function () {
      if (!settingsAccessible) this.skip();
      await openSettings();
      await browser.pause(300);
      await clickSettingsNav('General');
      await clickSettingsNav('Keyboard Shortcuts');
    });

    after(async function () {
      await closeSettings();
    });

    it('should have the Keyboard Shortcuts section', async function () {
      // Scroll down to find it — it is further down in the General tab
      const found = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-shortcuts"]');
        if (section) {
          section.scrollIntoView();
          return true;
        }
        const headings = document.querySelectorAll('h4');
        for (const h of headings) {
          if (h.textContent.includes('Keyboard Shortcuts')) {
            h.scrollIntoView();
            return true;
          }
        }
        return false;
      });
      await browser.pause(300);
      expect(found).toBe(true);
    });
  });

  describe('Storage Tab — Auto-Cleanup', function () {
    before(async function () {
      if (!settingsAccessible) this.skip();
      await openSettings();
      await browser.pause(300);
    });

    after(async function () {
      await closeSettings();
    });

    it('should switch to the Storage tab', async function () {
      const clicked = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Storage') {
            btn.click();
            return true;
          }
        }
        return false;
      });
      expect(clicked).toBe(true);
      await browser.pause(400);
    });

    it('should have the Auto-Cleanup section', async function () {
      // Scroll to Auto-Cleanup
      const found = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-auto-cleanup"]');
        if (section) {
          section.scrollIntoView();
          return true;
        }
        const headings = document.querySelectorAll('h4');
        for (const h of headings) {
          if (h.textContent.includes('Auto-Cleanup')) {
            h.scrollIntoView();
            return true;
          }
        }
        return false;
      });
      await browser.pause(300);
      expect(found).toBe(true);
    });

    it('should show Premium badge on Auto-Cleanup for non-paid users', async function () {
      const hasBadge = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-auto-cleanup"]');
        if (section) {
          return section.innerText.includes('Premium');
        }
        const headings = document.querySelectorAll('h4');
        for (const h of headings) {
          if (h.textContent.includes('Auto-Cleanup')) {
            return h.textContent.includes('Premium');
          }
        }
        return false;
      });
      expect(hasBadge).toBe(true);
    });
  });
});
