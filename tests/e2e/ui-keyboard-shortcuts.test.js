/**
 * E2E Test: Keyboard Shortcuts (UI-only, no email accounts required)
 *
 * Tests that keyboard shortcuts trigger the correct UI responses:
 * - Shortcuts modal (?)
 * - Compose modal (c)
 * - Search focus (/)
 * - Folder navigation sequences (g+i, g+s, g+d)
 */

import { waitForApp, pressKey, pressSequence } from './helpers.js';

describe('Keyboard Shortcuts', function () {
  this.timeout(30000);

  before(async function () {
    await waitForApp();
  });

  describe('Shortcuts Modal (?)', function () {
    it('should open the shortcuts modal when pressing ?', async function () {
      await pressKey('?');
      await browser.pause(500);

      // The ShortcutsModal renders "Keyboard Shortcuts" in its header
      // and section headings like "Navigation", "Actions", "Selection", "UI"
      const found = await browser.execute(() => {
        const allText = document.body.innerText;
        return allText.includes('Keyboard Shortcuts') &&
               allText.includes('Navigation') &&
               allText.includes('Actions');
      });

      expect(found).toBe(true);
    });

    it('should close the shortcuts modal with Escape', async function () {
      await pressKey('Escape');
      await browser.pause(400);

      const stillOpen = await browser.execute(() => {
        // The modal has a heading "Keyboard Shortcuts" — check it is gone
        const headings = document.querySelectorAll('h2');
        for (const h of headings) {
          if (h.textContent.includes('Keyboard Shortcuts') && h.offsetHeight > 0) {
            return true;
          }
        }
        return false;
      });

      expect(stillOpen).toBe(false);
    });
  });

  describe('Compose Shortcut (c)', function () {
    it('should open the compose modal when pressing c', async function () {
      await pressKey('c');
      await browser.pause(500);

      // ComposeModal renders a Send button and a To field
      const found = await browser.execute(() => {
        const allText = document.body.innerText;
        // The compose modal has "Send" button and input fields
        const hasComposeUI = allText.includes('Send') || allText.includes('To');
        // Look for a textarea or input with placeholder containing "To"
        const toInput = document.querySelector('input[placeholder*="To"], input[type="email"]');
        // Also check for the compose modal's close button or subject input
        const subjectInput = document.querySelector('input[placeholder*="Subject"]');
        return hasComposeUI && (toInput !== null || subjectInput !== null);
      });

      expect(found).toBe(true);
    });

    it('should close the compose modal with Escape', async function () {
      await pressKey('Escape');
      await browser.pause(400);

      const stillOpen = await browser.execute(() => {
        const subjectInput = document.querySelector('input[placeholder*="Subject"]');
        return subjectInput !== null && subjectInput.offsetHeight > 0;
      });

      expect(stillOpen).toBe(false);
    });
  });

  describe('Search Focus (/)', function () {
    it('should focus the search input when pressing /', async function () {
      await pressKey('/');
      await browser.pause(400);

      const focused = await browser.execute(() => {
        const active = document.activeElement;
        if (!active) return false;
        const tag = active.tagName.toLowerCase();
        const type = (active.getAttribute('type') || '').toLowerCase();
        const placeholder = (active.getAttribute('placeholder') || '').toLowerCase();
        // Should be an input that is likely a search field
        return (tag === 'input' && (type === 'text' || type === 'search' || type === '')) ||
               placeholder.includes('search');
      });

      expect(focused).toBe(true);

      // Blur the search input so it does not interfere with subsequent tests
      await pressKey('Escape');
      await browser.pause(300);
    });
  });

  describe('Folder Navigation Sequences', function () {
    it('should handle g+i (go to Inbox) without crashing', async function () {
      await pressSequence('g', 'i');
      await browser.pause(500);

      // Verify the app is still responsive
      const responsive = await browser.execute(() => {
        return document.querySelector('aside, nav') !== null;
      });

      expect(responsive).toBe(true);
    });

    it('should handle g+s (go to Sent) without crashing', async function () {
      await pressSequence('g', 's');
      await browser.pause(500);

      const responsive = await browser.execute(() => {
        return document.querySelector('aside, nav') !== null;
      });

      expect(responsive).toBe(true);
    });

    it('should handle g+d (go to Drafts) without crashing', async function () {
      await pressSequence('g', 'd');
      await browser.pause(500);

      const responsive = await browser.execute(() => {
        return document.querySelector('aside, nav') !== null;
      });

      expect(responsive).toBe(true);
    });
  });
});
