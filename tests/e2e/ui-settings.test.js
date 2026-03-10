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

import { waitForApp, openSettings, closeSettings, pressKey } from './helpers.js';

describe('Settings Page', function () {
  this.timeout(30000);

  before(async function () {
    await waitForApp();
  });

  after(async function () {
    // Ensure settings is closed at the end
    await closeSettings();
  });

  describe('General Tab — Undo Send', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
    });

    after(async function () {
      await closeSettings();
    });

    it('should have the Undo Send section', async function () {
      const found = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-undo-send"]');
        if (section && section.offsetHeight > 0) return true;
        return document.body.innerText.includes('Enable Undo Send');
      });
      expect(found).toBe(true);
    });

    it('should show delay dropdown when undo send is toggled on', async function () {
      // First, check if undo send is already on (state persists between sessions)
      const alreadyOn = await browser.execute(() => {
        return document.body.innerText.includes('Undo send delay');
      });

      if (!alreadyOn) {
        // Toggle it ON
        await browser.execute(() => {
          const labels = document.querySelectorAll('div');
          for (const label of labels) {
            if (label.textContent.trim() === 'Enable Undo Send') {
              const container = label.closest('.flex') || label.parentElement?.parentElement;
              if (!container) continue;
              const toggle = container.querySelector('.toggle-switch');
              if (toggle) {
                toggle.click();
                return true;
              }
            }
          }
          return false;
        });
        await browser.pause(400);
      }

      // Check if delay dropdown is visible
      const hasDropdown = await browser.execute(() => {
        return document.body.innerText.includes('Undo send delay');
      });
      expect(hasDropdown).toBe(true);

      // Toggle back off to restore state
      await browser.execute(() => {
        const labels = document.querySelectorAll('div');
        for (const label of labels) {
          if (label.textContent.trim() === 'Enable Undo Send') {
            const container = label.closest('.flex') || label.parentElement?.parentElement;
            if (!container) continue;
            const toggle = container.querySelector('.toggle-switch');
            if (toggle) {
              toggle.click();
              return true;
            }
          }
        }
        return false;
      });
      await browser.pause(300);
    });
  });

  describe('General Tab — Email Templates', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
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

  describe('General Tab — Notifications', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
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

  describe('General Tab — Keyboard Shortcuts', function () {
    before(async function () {
      await openSettings();
      await browser.pause(300);
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

    it('should show Pro badge on Auto-Cleanup for non-paid users', async function () {
      const hasBadge = await browser.execute(() => {
        const section = document.querySelector('[data-testid="settings-auto-cleanup"]');
        if (section) {
          return section.innerText.includes('Pro');
        }
        const headings = document.querySelectorAll('h4');
        for (const h of headings) {
          if (h.textContent.includes('Auto-Cleanup')) {
            return h.textContent.includes('Pro');
          }
        }
        return false;
      });
      expect(hasBadge).toBe(true);
    });
  });
});
