/**
 * E2E Test: Compose Modal & Template Integration (UI-only)
 *
 * Tests the compose modal opening and template insertion workflow:
 * 1. Create a template via settings UI
 * 2. Open compose modal
 * 3. Click the Templates button in the compose footer
 * 4. Select the template from the dropdown
 * 5. Verify the template body is inserted into the compose body
 * 6. Clean up by deleting the template
 */

import { waitForApp, openSettings, closeSettings, pressKey } from './helpers.js';

const TEST_TEMPLATE_NAME = 'E2E Compose Template';
const TEST_TEMPLATE_BODY = 'Hello, this is a test template inserted by E2E automation.';

describe('Compose Modal & Templates', function () {
  this.timeout(30000);

  before(async function () {
    await waitForApp();
  });

  describe('Setup — Create Template in Settings', function () {
    it('should create a test template', async function () {
      await openSettings();
      await browser.pause(400);

      // Click "Add Template"
      const clickedAdd = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes('Add Template') && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      expect(clickedAdd).toBe(true);
      await browser.pause(400);

      // Fill in template name — placeholder is "e.g. Follow-up..."
      await browser.execute((name) => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
          if (input.offsetHeight > 0 && (placeholder.includes('follow-up') || placeholder.includes('e.g.'))) {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            setter.call(input, name);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, TEST_TEMPLATE_NAME);
      await browser.pause(200);

      // Fill in template body — placeholder is "Write the template content here..."
      await browser.execute((body) => {
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          const placeholder = (ta.getAttribute('placeholder') || '').toLowerCase();
          if (ta.offsetHeight > 0 && placeholder.includes('template')) {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            setter.call(ta, body);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, TEST_TEMPLATE_BODY);
      await browser.pause(200);

      // Click Save
      await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim();
          if ((text === 'Save' || text.includes('Save')) && btn.offsetHeight > 0 && !btn.disabled) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      await browser.pause(400);

      // Verify it was saved
      const saved = await browser.execute((name) => {
        return document.body.innerText.includes(name);
      }, TEST_TEMPLATE_NAME);
      expect(saved).toBe(true);

      await closeSettings();
    });
  });

  describe('Compose Modal — Template Insertion', function () {
    it('should open compose modal with c key', async function () {
      await pressKey('c');
      await browser.pause(500);

      const opened = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (modal && modal.offsetHeight > 0) return true;
        const subjectInput = document.querySelector('[data-testid="compose-subject"]');
        return subjectInput !== null && subjectInput.offsetHeight > 0;
      });
      expect(opened).toBe(true);
    });

    it('should find and click the Templates button in compose footer', async function () {
      const clicked = await browser.execute(() => {
        // Use data-testid first
        const btn = document.querySelector('[data-testid="compose-templates-btn"]');
        if (btn && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
        // Fallback: look for button with title="Templates"
        const fallback = document.querySelector('button[title="Templates"]');
        if (fallback && fallback.offsetHeight > 0) {
          fallback.click();
          return true;
        }
        return false;
      });
      expect(clicked).toBe(true);
      await browser.pause(400);
    });

    it('should show the test template in the dropdown', async function () {
      const found = await browser.execute((name) => {
        // The dropdown renders template names as button text
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes(name) && btn.offsetHeight > 0) {
            return true;
          }
        }
        return false;
      }, TEST_TEMPLATE_NAME);
      expect(found).toBe(true);
    });

    it('should insert the template into the compose body', async function () {
      // Click the template entry in the dropdown
      await browser.execute((name) => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes(name) && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      }, TEST_TEMPLATE_NAME);
      await browser.pause(500);

      // Verify the compose body textarea contains the template text
      const bodyContainsTemplate = await browser.execute((expectedText) => {
        const body = document.querySelector('[data-testid="compose-body"]');
        if (body && body.value && body.value.includes(expectedText)) return true;
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          if (ta.value && ta.value.includes(expectedText)) {
            return true;
          }
        }
        return false;
      }, TEST_TEMPLATE_BODY);
      expect(bodyContainsTemplate).toBe(true);
    });

    it('should close the compose modal with Escape', async function () {
      await pressKey('Escape');
      await browser.pause(800);

      let stillOpen = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        return modal !== null && modal.offsetHeight > 0;
      });

      // Fallback: dispatch Escape directly
      if (stillOpen) {
        await browser.execute(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
          }));
        });
        await browser.pause(800);

        stillOpen = await browser.execute(() => {
          const modal = document.querySelector('[data-testid="compose-modal"]');
          return modal !== null && modal.offsetHeight > 0;
        });
      }

      expect(stillOpen).toBe(false);
    });
  });

  describe('Cleanup — Delete Template', function () {
    it('should remove the test template from settings', async function () {
      await openSettings();
      await browser.pause(400);

      // Find and delete the template
      const deleted = await browser.execute((name) => {
        const allDivs = document.querySelectorAll('div');
        for (const el of allDivs) {
          if (el.textContent.trim() === name && el.className.includes('font-medium')) {
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
      }, TEST_TEMPLATE_NAME);

      await browser.pause(400);

      // Verify it is gone
      const gone = await browser.execute((name) => {
        return !document.body.innerText.includes(name);
      }, TEST_TEMPLATE_NAME);

      expect(deleted).toBe(true);
      expect(gone).toBe(true);

      await closeSettings();
    });
  });
});
