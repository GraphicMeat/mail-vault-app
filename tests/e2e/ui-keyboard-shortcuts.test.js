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

  let appState;
  before(async function () {
    appState = await waitForApp();
  });

  describe('Shortcuts Modal (?)', function () {
    it('should open the shortcuts modal when pressing ?', async function () {
      if (appState !== 'ready') this.skip();
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
      // Try browser.keys first, then fall back to dispatching event directly
      await pressKey('Escape');
      await browser.pause(800);

      let stillOpen = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="shortcuts-modal"]');
        return modal !== null && modal.offsetHeight > 0;
      });

      // If still open, dispatch Escape event directly (WebDriver key dispatch
      // may not trigger keydown listeners in WKWebView reliably)
      if (stillOpen) {
        await browser.execute(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
          }));
        });
        await browser.pause(800);

        stillOpen = await browser.execute(() => {
          const modal = document.querySelector('[data-testid="shortcuts-modal"]');
          return modal !== null && modal.offsetHeight > 0;
        });
      }

      expect(stillOpen).toBe(false);
    });
  });

  describe('Compose Shortcut (c)', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
    });

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

  describe('Search Focus (/)', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
    });

    it('should focus the search input when pressing /', async function () {
      // The search input is inside EmailList and may not be rendered immediately.
      // Wait for it to exist first.
      const searchExists = await browser.execute(() => {
        const input = document.querySelector('input[placeholder*="Search"], input[placeholder*="search"]');
        return input !== null;
      });

      if (!searchExists) {
        // SearchBar not rendered (e.g. no emails loaded yet) — skip gracefully
        this.skip();
        return;
      }

      // Dispatch / keydown to trigger focusSearch
      await browser.execute(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: '/', code: 'Slash', keyCode: 191, bubbles: true,
        }));
      });
      await browser.pause(400);

      const focused = await browser.execute(() => {
        const active = document.activeElement;
        if (!active) return false;
        const placeholder = (active.getAttribute('placeholder') || '').toLowerCase();
        return active.tagName === 'INPUT' && placeholder.includes('search');
      });

      expect(focused).toBe(true);

      // Blur the search input
      await browser.execute(() => {
        document.activeElement?.blur();
      });
      await browser.pause(300);
    });
  });

  describe('Folder Navigation Sequences', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
    });

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
