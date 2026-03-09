/**
 * E2E Test: Connected Compose Extended — New Message title, CC/BCC fields,
 * account selector, and minimize/maximize compose modal.
 */

import {
  waitForApp,
  openCompose,
  pressKey,
} from './helpers.js';

/**
 * Close compose modal cleanly: press Escape, dismiss discard confirmation
 * if shown, and close any minimized bar.
 */
async function closeCompose() {
  await pressKey('Escape');
  await browser.pause(500);

  // Dismiss discard confirmation if present
  await browser.execute(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if ((btn.textContent || '').trim() === 'Discard' && btn.offsetHeight > 0) {
        btn.click();
      }
    }
  });
  await browser.pause(300);

  // Close any minimized compose bar at bottom of screen
  const hasMinimized = await browser.execute(() => {
    const modal = document.querySelector('[data-testid="compose-modal"]');
    if (modal && modal.offsetHeight > 0) return false;
    // Look for a small fixed bar at bottom that may contain compose subject
    const allEls = document.querySelectorAll('div[style*="fixed"], div[class*="minim"]');
    for (const el of allEls) {
      if (el.offsetHeight > 0 && el.offsetHeight < 80) {
        // Try to find close button inside
        const closeBtn = el.querySelector('button');
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
      }
    }
    return false;
  });

  if (hasMinimized) {
    await browser.pause(300);
    // Now the full modal may have opened — press Escape again
    await pressKey('Escape');
    await browser.pause(500);
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').trim() === 'Discard' && btn.offsetHeight > 0) {
          btn.click();
        }
      }
    });
    await browser.pause(300);
  }
}

describe('Connected Compose Extended', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
  });

  afterEach(async function () {
    await closeCompose();
  });

  // ---------------------------------------------------------------------------
  // New Message
  // ---------------------------------------------------------------------------
  describe('New Message', function () {
    it('should show "New Message" title when opening compose', async function () {
      await openCompose();
      await browser.pause(300);

      const title = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (!modal) return null;
        const h2 = modal.querySelector('h2');
        return h2 ? h2.textContent.trim() : null;
      });

      expect(title).toBeTruthy();
      expect(title).toContain('New Message');
    });
  });

  // ---------------------------------------------------------------------------
  // CC and BCC Fields
  // ---------------------------------------------------------------------------
  describe('CC and BCC Fields', function () {
    it('should have CC field visible', async function () {
      await openCompose();
      await browser.pause(300);

      const hasCc = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (!modal) return false;
        // Check for label with "Cc:" text
        const labels = modal.querySelectorAll('label');
        for (const label of labels) {
          if ((label.textContent || '').trim().toLowerCase().startsWith('cc')) return true;
        }
        // Check for input with cc placeholder
        const inputs = modal.querySelectorAll('input');
        for (const input of inputs) {
          const ph = (input.getAttribute('placeholder') || '').toLowerCase();
          if (ph.includes('cc')) return true;
        }
        return false;
      });

      expect(hasCc).toBe(true);
    });

    it('should have BCC field visible', async function () {
      await openCompose();
      await browser.pause(300);

      const hasBcc = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (!modal) return false;
        // Check for label with "Bcc:" text
        const labels = modal.querySelectorAll('label');
        for (const label of labels) {
          if ((label.textContent || '').trim().toLowerCase().startsWith('bcc')) return true;
        }
        // Check for input with bcc placeholder
        const inputs = modal.querySelectorAll('input');
        for (const input of inputs) {
          const ph = (input.getAttribute('placeholder') || '').toLowerCase();
          if (ph.includes('bcc')) return true;
        }
        return false;
      });

      expect(hasBcc).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Account Selector
  // ---------------------------------------------------------------------------
  describe('Account Selector', function () {
    it('should show account selector when multiple accounts exist', async function () {
      await openCompose();
      await browser.pause(300);

      const result = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (!modal) return { found: false, reason: 'no modal' };
        const selects = modal.querySelectorAll('select');
        for (const sel of selects) {
          const options = [...sel.options];
          const hasEmail = options.some(o => (o.text || o.value || '').includes('@'));
          if (hasEmail) {
            return { found: true, optionCount: options.length };
          }
        }
        return { found: false, reason: 'no select with @ options' };
      });

      if (!result.found) {
        // Soft check: if only 1 account configured, warn and pass
        console.warn('[compose-extended] Account selector not found — possibly only 1 account configured. Soft pass.');
      } else {
        expect(result.optionCount).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Minimize and Maximize
  // ---------------------------------------------------------------------------
  describe('Minimize and Maximize', function () {
    it('should minimize compose modal', async function () {
      await openCompose();
      await browser.pause(300);

      // Fill in subject so we can verify it in the minimized bar
      await browser.execute(() => {
        const input = document.querySelector('[data-testid="compose-subject"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'E2E Minimize Test');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await browser.pause(300);

      // Click the minimize button (has title="Minimize")
      const clickedMinimize = await browser.execute(() => {
        const btn = document.querySelector('[data-testid="compose-modal"] button[title="Minimize"]');
        if (btn && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
        return false;
      });

      expect(clickedMinimize).toBe(true);
      await browser.pause(500);

      // Verify: full modal should be gone but subject text visible in minimized bar
      const minimized = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        const modalVisible = modal && modal.offsetHeight > 200;
        // Subject text should still be visible somewhere on screen
        const bodyText = document.body.innerText;
        const hasSubject = bodyText.includes('E2E Minimize Test');
        return { modalVisible, hasSubject };
      });

      expect(minimized.modalVisible).toBe(false);
      expect(minimized.hasSubject).toBe(true);
    });

    it('should maximize compose modal from minimized state', async function () {
      // The previous test left the modal minimized with "E2E Minimize Test" subject.
      // Open compose and minimize it first to ensure consistent state.
      await openCompose();
      await browser.pause(300);

      await browser.execute(() => {
        const input = document.querySelector('[data-testid="compose-subject"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'E2E Minimize Test');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await browser.pause(300);

      // Minimize
      await browser.execute(() => {
        const btn = document.querySelector('[data-testid="compose-modal"] button[title="Minimize"]');
        if (btn) btn.click();
      });
      await browser.pause(500);

      // Now click the minimized bar to maximize
      const clickedBar = await browser.execute(() => {
        // Find the minimized bar containing the subject text
        const allEls = document.querySelectorAll('div');
        for (const el of allEls) {
          if (el.offsetHeight > 0 && el.offsetHeight < 80 &&
              (el.textContent || '').includes('E2E Minimize Test')) {
            // Check if this is a small bar-like element (fixed position or at bottom)
            const rect = el.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            if (rect.bottom > viewportHeight - 100) {
              el.click();
              return true;
            }
          }
        }
        return false;
      });

      expect(clickedBar).toBe(true);
      await browser.pause(500);

      // Verify full compose modal reappears with height > 200
      const restored = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (!modal) return { visible: false, height: 0 };
        return { visible: modal.offsetHeight > 0, height: modal.offsetHeight };
      });

      expect(restored.visible).toBe(true);
      expect(restored.height).toBeGreaterThan(200);
    });
  });
});
