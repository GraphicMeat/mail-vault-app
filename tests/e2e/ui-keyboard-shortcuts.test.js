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

      // Check for the shortcuts modal via data-testid, fall back to text content
      const found = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="shortcuts-modal"]');
        if (modal && modal.offsetHeight > 0) return true;
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
        // Check via data-testid first
        const modal = document.querySelector('[data-testid="shortcuts-modal"]');
        if (modal && modal.offsetHeight > 0) return true;
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

      // Check for compose modal via data-testid, fall back to heuristics
      const found = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (modal && modal.offsetHeight > 0) return true;
        const toInput = document.querySelector('[data-testid="compose-to"]');
        const subjectInput = document.querySelector('[data-testid="compose-subject"]');
        return (toInput !== null || subjectInput !== null);
      });

      expect(found).toBe(true);
    });

    it('should close the compose modal with Escape', async function () {
      await pressKey('Escape');
      await browser.pause(400);

      const stillOpen = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        if (modal && modal.offsetHeight > 0) return true;
        const subjectInput = document.querySelector('[data-testid="compose-subject"]');
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
        return document.querySelector('[data-testid="sidebar"]') !== null;
      });

      expect(responsive).toBe(true);
    });

    it('should handle g+s (go to Sent) without crashing', async function () {
      await pressSequence('g', 's');
      await browser.pause(500);

      const responsive = await browser.execute(() => {
        return document.querySelector('[data-testid="sidebar"]') !== null;
      });

      expect(responsive).toBe(true);
    });

    it('should handle g+d (go to Drafts) without crashing', async function () {
      await pressSequence('g', 'd');
      await browser.pause(500);

      const responsive = await browser.execute(() => {
        return document.querySelector('[data-testid="sidebar"]') !== null;
      });

      expect(responsive).toBe(true);
    });
  });
});
