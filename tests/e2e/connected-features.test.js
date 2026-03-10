/**
 * E2E Test: Connected Features — Undo Send & Sender Insights (Task 10)
 *
 * Undo Send:
 *   1. Enable undo send in settings (5s delay)
 *   2. Open compose, fill To/Subject/Body
 *   3. Click Send
 *   4. Verify countdown toast ("Sending in")
 *   5. Click Undo
 *   6. Verify compose reopens with fields intact
 *   7. Close compose
 *   8. Disable undo send (cleanup)
 *
 * Sender Insights:
 *   1. Wait for emails and select one
 *   2. Click the insights icon next to sender name
 *   3. Verify insights panel appears
 *   4. Click again to hide
 */

import {
  waitForApp,
  waitForEmails,
  openSettings,
  closeSettings,
  pressKey,
} from './helpers.js';

describe('Connected Features', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
  });

  // ---------------------------------------------------------------------------
  // Undo Send
  // ---------------------------------------------------------------------------
  describe('Undo Send', function () {
    it('should enable undo send in settings with 5s delay', async function () {
      await openSettings();
      await browser.pause(500);

      // Find the "Enable Undo Send" toggle and turn it ON
      const toggled = await browser.execute(() => {
        const labels = document.querySelectorAll('div, span, label');
        for (const label of labels) {
          if ((label.textContent || '').trim() === 'Enable Undo Send') {
            const container = label.closest('.flex') || label.parentElement?.parentElement;
            if (!container) continue;
            const toggle = container.querySelector('.toggle-switch');
            if (toggle) {
              // Check if already on — ToggleSwitch uses .active class
              const isOn = (toggle.className || '').includes('active');
              if (!isOn) {
                toggle.click();
              }
              return true;
            }
          }
        }
        return false;
      });

      expect(toggled).toBe(true);
      await browser.pause(500);

      // Set delay to 5 seconds if a dropdown is available
      await browser.execute(() => {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          // Look for a select near "Undo send delay"
          const opts = [...sel.options].map(o => o.value);
          if (opts.includes('5') || opts.includes('5000')) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(sel, opts.includes('5') ? '5' : '5000');
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      });
      await browser.pause(300);

      await closeSettings();
    });

    it('should open compose and fill in email fields', async function () {
      await pressKey('c');
      await browser.pause(500);

      // Verify compose modal is open
      const opened = await browser.execute(() => {
        return document.querySelector('[data-testid="compose-modal"]') !== null;
      });
      expect(opened).toBe(true);

      const timestamp = Date.now();

      // Fill To field
      await browser.execute((toEmail) => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          const ph = (input.getAttribute('placeholder') || '').toLowerCase();
          if (ph.includes('to') || ph.includes('recipient')) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, toEmail);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // Simulate Enter to confirm the recipient (chip-based input)
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return;
          }
        }
      }, browser.testEnv.TEST_EMAIL);
      await browser.pause(300);

      // Fill Subject
      await browser.execute((ts) => {
        const input = document.querySelector('input[placeholder*="Subject"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, `E2E Undo Test ${ts}`);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, timestamp);
      await browser.pause(200);

      // Fill Body
      await browser.execute(() => {
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          if (ta.offsetHeight > 0) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, 'This is an automated E2E undo send test. This email should NOT be sent.');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      });
      await browser.pause(300);
    });

    it('should show countdown toast after clicking Send', async function () {
      // Click Send button via data-testid
      const clicked = await browser.execute(() => {
        const btn = document.querySelector('[data-testid="compose-send"]');
        if (btn && btn.offsetHeight > 0 && !btn.disabled) {
          btn.click();
          return true;
        }
        // Fallback
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          const text = (b.textContent || '').trim();
          if ((text === 'Send' || text.includes('Send')) &&
              b.offsetHeight > 0 && !b.disabled &&
              !text.includes('Undo')) {
            b.click();
            return true;
          }
        }
        return false;
      });

      expect(clicked).toBe(true);
      await browser.pause(500);

      // Verify countdown toast appears with "Sending in" text
      const hasCountdown = await browser.execute(() => {
        return document.body.innerText.includes('Sending in');
      });

      expect(hasCountdown).toBe(true);
    });

    it('should undo the send and reopen compose', async function () {
      // Click the Undo button on the toast via data-testid
      const clickedUndo = await browser.execute(() => {
        const btn = document.querySelector('[data-testid="undo-send-btn"]');
        if (btn && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
        // Fallback
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          const text = (b.textContent || '').trim();
          if (text.includes('Undo') && b.offsetHeight > 0) {
            b.click();
            return true;
          }
        }
        return false;
      });

      expect(clickedUndo).toBe(true);
      await browser.pause(1000);

      // Verify compose modal reopened with the subject intact
      const composeReopened = await browser.execute(() => {
        const subjectInput = document.querySelector('[data-testid="compose-subject"]');
        if (!subjectInput || subjectInput.offsetHeight === 0) return false;
        return (subjectInput.value || '').includes('E2E Undo Test');
      });

      expect(composeReopened).toBe(true);
    });

    it('should close compose without sending', async function () {
      await pressKey('Escape');
      await browser.pause(500);

      // If there is a discard confirmation, click Discard
      const hasConfirm = await browser.execute(() => {
        return document.body.innerText.includes('Discard');
      });

      if (hasConfirm) {
        await browser.execute(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if ((btn.textContent || '').trim() === 'Discard' && btn.offsetHeight > 0) {
              btn.click();
              return;
            }
          }
        });
        await browser.pause(500);
      }

      // Verify compose is closed
      const closed = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (modal && modal.offsetHeight > 0) return false;
        return true;
      });

      expect(closed).toBe(true);
    });

    it('should disable undo send in settings (cleanup)', async function () {
      await openSettings();
      await browser.pause(500);

      // Turn off the "Enable Undo Send" toggle
      await browser.execute(() => {
        const labels = document.querySelectorAll('div, span, label');
        for (const label of labels) {
          if ((label.textContent || '').trim() === 'Enable Undo Send') {
            const container = label.closest('.flex') || label.parentElement?.parentElement;
            if (!container) continue;
            const toggle = container.querySelector('.toggle-switch');
            if (toggle) {
              const isOn = toggle.getAttribute('aria-checked') === 'true' ||
                (toggle.className || '').includes('accent');
              if (isOn) {
                toggle.click();
              }
              return true;
            }
          }
        }
        return false;
      });

      await browser.pause(300);
      await closeSettings();
    });
  });

  // ---------------------------------------------------------------------------
  // Sender Insights
  // ---------------------------------------------------------------------------
  describe('Sender Insights', function () {
    before(async function () {
      await waitForEmails();
    });

    it('should select an email to view', async function () {
      // Click the first email row
      const clicked = await browser.execute(() => {
        const row = document.querySelector('[data-testid="email-row"]');
        if (row) { row.click(); return true; }

        const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
        for (const r of virtualRows) {
          if (r.offsetHeight > 20 && r.textContent.trim().length > 0) {
            r.click();
            return true;
          }
        }

        const listArea = document.querySelector('[class*="email-list"], [class*="EmailList"], main');
        if (listArea) {
          const children = listArea.querySelectorAll('[class*="row"], [class*="Row"], [class*="item"]');
          if (children.length > 0) { children[0].click(); return true; }
        }

        return false;
      });

      expect(clicked).toBe(true);
      await browser.pause(1500);
    });

    it('should find and click the sender insights icon', async function () {
      const clicked = await browser.execute(() => {
        // Use data-testid first
        const btn = document.querySelector('[data-testid="sender-insights-toggle"]');
        if (btn && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
        // Fallback
        const fallback = document.querySelector('button[title="Sender insights"]');
        if (fallback && fallback.offsetHeight > 0) {
          fallback.click();
          return true;
        }
        return false;
      });

      expect(clicked).toBe(true);
      await browser.pause(500);
    });

    it('should show the sender insights panel', async function () {
      const panelVisible = await browser.execute(() => {
        const panel = document.querySelector('[data-testid="sender-insights-panel"]');
        if (panel && panel.offsetHeight > 0) return true;
        const text = document.body.innerText;
        return text.includes('exchanged') || text.includes('received') ||
               text.includes('Sender Insights') || text.includes('sender insights');
      });

      expect(panelVisible).toBe(true);
    });

    it('should hide the insights panel when clicking the icon again', async function () {
      // Click the insights button again to toggle off
      const clicked = await browser.execute(() => {
        const btn = document.querySelector('[data-testid="sender-insights-toggle"]');
        if (btn && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
        return false;
      });

      expect(clicked).toBe(true);
      await browser.pause(500);

      // Verify the insights content is gone
      const panelHidden = await browser.execute(() => {
        const text = document.body.innerText;
        // The panel-specific content should be gone
        return !text.includes('Emails exchanged');
      });

      expect(panelHidden).toBe(true);
    });
  });
});
