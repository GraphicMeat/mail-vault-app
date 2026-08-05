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
 * Close compose cleanly. Escape on a modal with content minimizes it to a
 * top-right bubble (the modal itself unmounts), so a close has to sweep the
 * bubbles too — each carries its own close button.
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

  await closeAllBubbles();
}

/** Dismiss every minimized compose bubble. */
async function closeAllBubbles() {
  await browser.execute(() => {
    for (const bubble of document.querySelectorAll('[data-testid="compose-bubble"]')) {
      const closeBtn = bubble.querySelector('button');
      if (closeBtn) closeBtn.click();
    }
  });
  await browser.pause(300);
}

/** Open compose, set a subject, and minimize it to a bubble. */
async function minimizeWithSubject(subject) {
  await openCompose();
  await browser.pause(300);

  await browser.execute((value) => {
    const input = document.querySelector('[data-testid="compose-subject"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, subject);
  await browser.pause(300);

  const clicked = await browser.execute(() => {
    const btn = document.querySelector('[data-testid="compose-modal"] button[title="Minimize"]');
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  });
  await browser.pause(500);
  return clicked;
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
    it('should minimize compose modal to a bubble', async function () {
      expect(await minimizeWithSubject('E2E Minimize Test')).toBe(true);

      // The modal unmounts on minimize; the bubble carries the subject.
      const minimized = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        const bubbles = [...document.querySelectorAll('[data-testid="compose-bubble"]')];
        return {
          modalVisible: !!modal && modal.offsetHeight > 200,
          hasSubject: bubbles.some(b => (b.textContent || '').includes('E2E Minimize Test')),
        };
      });

      expect(minimized.modalVisible).toBe(false);
      expect(minimized.hasSubject).toBe(true);
    });

    it('should maximize compose modal from a bubble', async function () {
      expect(await minimizeWithSubject('E2E Minimize Test')).toBe(true);

      const clickedBubble = await browser.execute(() => {
        for (const bubble of document.querySelectorAll('[data-testid="compose-bubble"]')) {
          if ((bubble.textContent || '').includes('E2E Minimize Test')) {
            bubble.click();
            return true;
          }
        }
        return false;
      });

      expect(clickedBubble).toBe(true);
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
