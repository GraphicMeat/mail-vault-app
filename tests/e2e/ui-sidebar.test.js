/**
 * E2E Test: Sidebar Interactions (UI-only, no email accounts required)
 *
 * Tests sidebar UI elements and interactions:
 * - Collapse and expand toggle
 * - Theme toggle (dark/light mode)
 * - Compose button opens compose modal
 * - Settings button opens settings page
 */

import { waitForApp, pressKey, closeSettings } from './helpers.js';

describe('Sidebar Interactions', function () {
  this.timeout(30000);

  before(async function () {
    await waitForApp();
  });

  describe('Collapse and Expand', function () {
    it('should have a collapse/expand toggle button', async function () {
      const found = await browser.execute(() => {
        const collapse = document.querySelector('button[title="Collapse sidebar"]');
        const expand = document.querySelector('button[title="Expand sidebar"]');
        return (collapse !== null && collapse.offsetHeight > 0) ||
               (expand !== null && expand.offsetHeight > 0);
      });
      expect(found).toBe(true);
    });

    it('should collapse the sidebar when clicking collapse button', async function () {
      // Handle persisted state: if already collapsed, expand first
      const alreadyCollapsed = await browser.execute(() => {
        return document.querySelector('button[title="Expand sidebar"]') !== null;
      });

      if (alreadyCollapsed) {
        await browser.execute(() => {
          document.querySelector('button[title="Expand sidebar"]').click();
        });
        await browser.pause(500);
      }

      // Now click collapse
      await browser.execute(() => {
        const btn = document.querySelector('button[title="Collapse sidebar"]');
        if (btn) btn.click();
      });
      await browser.pause(500);

      // Verify expand button appears after collapsing
      const expandVisible = await browser.execute(() => {
        const btn = document.querySelector('button[title="Expand sidebar"]');
        return btn !== null && btn.offsetHeight > 0;
      });
      expect(expandVisible).toBe(true);
    });

    it('should expand the sidebar when clicking expand button', async function () {
      // Handle persisted state: if already expanded, collapse first
      const alreadyExpanded = await browser.execute(() => {
        return document.querySelector('button[title="Collapse sidebar"]') !== null;
      });

      if (alreadyExpanded) {
        await browser.execute(() => {
          document.querySelector('button[title="Collapse sidebar"]').click();
        });
        await browser.pause(500);
      }

      // Now click expand
      await browser.execute(() => {
        const btn = document.querySelector('button[title="Expand sidebar"]');
        if (btn) btn.click();
      });
      await browser.pause(500);

      // Verify collapse button appears after expanding
      const collapseVisible = await browser.execute(() => {
        const btn = document.querySelector('button[title="Collapse sidebar"]');
        return btn !== null && btn.offsetHeight > 0;
      });
      expect(collapseVisible).toBe(true);
    });
  });

  describe('Theme Toggle', function () {
    it('should have a theme toggle button', async function () {
      const found = await browser.execute(() => {
        const dark = document.querySelector('button[title="Switch to dark mode"]');
        const light = document.querySelector('button[title="Switch to light mode"]');
        return (dark !== null && dark.offsetHeight > 0) ||
               (light !== null && light.offsetHeight > 0);
      });
      expect(found).toBe(true);
    });

    it('should toggle theme when clicked', async function () {
      // Get initial theme state (app uses data-theme attribute, not dark class)
      const wasDark = await browser.execute(() => {
        return document.documentElement.getAttribute('data-theme') === 'dark';
      });

      // Click the visible theme toggle button (sidebar renders both collapsed and expanded versions)
      await browser.execute((isDark) => {
        const selector = isDark
          ? 'button[title="Switch to light mode"]'
          : 'button[title="Switch to dark mode"]';
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          if (btn.offsetHeight > 0) { btn.click(); break; }
        }
      }, wasDark);
      await browser.pause(500);

      // Verify theme changed
      const isDarkNow = await browser.execute(() => {
        return document.documentElement.getAttribute('data-theme') === 'dark';
      });
      expect(isDarkNow).toBe(!wasDark);

      // Toggle back to restore original state
      await browser.execute((isDark) => {
        const selector = isDark
          ? 'button[title="Switch to light mode"]'
          : 'button[title="Switch to dark mode"]';
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          if (btn.offsetHeight > 0) { btn.click(); break; }
        }
      }, isDarkNow);
      await browser.pause(500);

      // Verify restored
      const restored = await browser.execute(() => {
        return document.documentElement.getAttribute('data-theme') === 'dark';
      });
      expect(restored).toBe(wasDark);
    });
  });

  describe('Compose Button', function () {
    it('should open compose modal when clicking compose button', async function () {
      // Find visible compose button (collapsed has title="Compose", expanded has text "Compose")
      await browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return;
        const buttons = sidebar.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.offsetHeight === 0) continue;
          const title = btn.getAttribute('title') || '';
          const text = btn.textContent.trim();
          if (title === 'Compose' || text === 'Compose') { btn.click(); return; }
        }
      });
      await browser.pause(500);

      const found = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        return modal !== null && modal.offsetHeight > 0;
      });
      expect(found).toBe(true);

      // Close the compose modal with Escape + fallback
      await pressKey('Escape');
      await browser.pause(800);

      let stillOpen = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="compose-modal"]');
        return modal !== null && modal.offsetHeight > 0;
      });

      if (stillOpen) {
        await browser.execute(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
          }));
        });
        await browser.pause(800);
      }
    });
  });

  describe('Settings Button', function () {
    it('should open settings when clicking settings button', async function () {
      // Find visible settings button (collapsed has title="Settings", expanded has text "Settings")
      await browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return;
        const buttons = sidebar.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.offsetHeight === 0) continue;
          const title = btn.getAttribute('title') || '';
          const text = btn.textContent.trim();
          if (title === 'Settings' || text === 'Settings') { btn.click(); return; }
        }
      });
      await browser.pause(500);

      const found = await browser.execute(() => {
        const page = document.querySelector('[data-testid="settings-page"]');
        return page !== null && page.offsetHeight > 0;
      });
      expect(found).toBe(true);

      // Close settings
      await closeSettings();
    });
  });
});
