/**
 * E2E Visual Regression: Main App Screens
 *
 * Captures baseline screenshots of all major screens:
 * email-list, sidebar-expanded, sidebar-collapsed, email-viewer,
 * compose-modal, thread-view, chat-view.
 *
 * Uses freezeDynamicContent() before every screenshot to mask
 * timestamps, avatars, and animations that cause false positives.
 */

import { waitForApp, waitForEmails, pressKey } from './helpers.js';

/**
 * Freeze dynamic content before screenshots to prevent false positives.
 * Hides timestamps, avatars, and stops animations.
 */
async function freezeDynamicContent() {
  await browser.execute(() => {
    // Freeze timestamps/dates to static text
    document.querySelectorAll('[data-testid="email-date"], .email-date, time').forEach(el => {
      el.textContent = '2026-01-01';
      el.style.visibility = 'hidden';
    });
    // Hide avatar images that may load dynamically
    document.querySelectorAll('.avatar, [data-testid="avatar"]').forEach(el => {
      el.style.visibility = 'hidden';
    });
    // Freeze any loading spinners
    document.querySelectorAll('.animate-spin, .loading').forEach(el => {
      el.style.animation = 'none';
    });
    // Freeze relative time displays (e.g. "2 minutes ago")
    document.querySelectorAll('[data-testid="relative-time"]').forEach(el => {
      el.textContent = 'Jan 1';
      el.style.visibility = 'hidden';
    });
    // Stop any CSS transitions mid-flight
    document.querySelectorAll('*').forEach(el => {
      el.style.transition = 'none';
    });
  });
}

describe('Visual Regression — Main Screens', function () {
  this.timeout(120000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('email list matches baseline', async function () {
    await browser.pause(1000);
    await freezeDynamicContent();
    const result = await browser.checkScreen('email-list', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);
  });

  it('sidebar expanded matches baseline', async function () {
    await freezeDynamicContent();
    // Verify sidebar is visible
    const sidebarVisible = await browser.execute(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      return sidebar !== null && sidebar.offsetHeight > 0;
    });
    expect(sidebarVisible).toBe(true);
    const result = await browser.checkScreen('sidebar-expanded', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);
  });

  it('sidebar collapsed matches baseline', async function () {
    // Click sidebar collapse toggle
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        if (
          (ariaLabel.includes('collapse') || title.includes('collapse') ||
           ariaLabel.includes('toggle sidebar') || title.includes('toggle sidebar')) &&
          btn.offsetHeight > 0
        ) {
          btn.click();
          return true;
        }
      }
      // Fallback: look for PanelLeftClose icon button
      const svgs = document.querySelectorAll('svg');
      for (const svg of svgs) {
        const parent = svg.closest('button');
        if (parent && parent.offsetHeight > 0) {
          const label = (parent.getAttribute('aria-label') || parent.getAttribute('title') || '').toLowerCase();
          if (label.includes('collapse') || label.includes('panel')) {
            parent.click();
            return true;
          }
        }
      }
      return false;
    });
    await browser.pause(300);
    await freezeDynamicContent();
    const result = await browser.checkScreen('sidebar-collapsed', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);

    // Re-expand sidebar
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        if (
          (ariaLabel.includes('expand') || title.includes('expand') ||
           ariaLabel.includes('toggle sidebar') || title.includes('toggle sidebar')) &&
          btn.offsetHeight > 0
        ) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await browser.pause(300);
  });

  it('email viewer matches baseline', async function () {
    // Click first email in list
    await browser.execute(() => {
      const row = document.querySelector('[data-testid="email-row"]');
      if (row && row.offsetHeight > 0) {
        row.click();
        return true;
      }
      // Fallback: virtualized rows
      const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
      if (virtualRows.length > 0) {
        virtualRows[0].click();
        return true;
      }
      return false;
    });
    await browser.pause(1000);
    await freezeDynamicContent();
    const result = await browser.checkScreen('email-viewer', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);
  });

  it('compose modal matches baseline', async function () {
    await browser.keys('c');
    await browser.pause(500);
    await freezeDynamicContent();
    const result = await browser.checkScreen('compose-modal', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);
    // Close compose
    await pressKey('Escape');
    await browser.pause(300);
    // Dismiss discard confirmation if present
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').trim() === 'Discard' && btn.offsetHeight > 0) {
          btn.click();
          return;
        }
      }
    });
    await browser.pause(300);
  });

  it('thread view matches baseline', async function () {
    // Find and click a thread row (multi-email thread with message count badge > 1)
    const foundThread = await browser.execute(() => {
      // Look for thread rows with a count badge
      const badges = document.querySelectorAll('[data-testid="thread-count"], .thread-count, .message-count');
      for (const badge of badges) {
        const count = parseInt(badge.textContent, 10);
        if (count > 1) {
          const row = badge.closest('[data-testid="thread-row"], [data-testid="email-row"], [class*="ThreadRow"], [class*="thread-row"]') ||
            badge.closest('[style*="position: absolute"]');
          if (row) {
            row.click();
            return true;
          }
        }
      }
      // Fallback: look for any row that has a count indicator (e.g. "(3)" text)
      const rows = document.querySelectorAll('[data-testid="email-row"], [data-testid="thread-row"], [style*="position: absolute"][style*="top:"]');
      for (const row of rows) {
        const text = row.textContent || '';
        const match = text.match(/\((\d+)\)/);
        if (match && parseInt(match[1], 10) > 1) {
          row.click();
          return true;
        }
      }
      return false;
    });

    if (!foundThread) {
      console.warn('[visual] No multi-email thread found — skipping thread view baseline');
      this.skip();
      return;
    }

    await browser.pause(1000);
    await freezeDynamicContent();
    const result = await browser.checkScreen('thread-view', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);
  });

  it('chat view matches baseline', async function () {
    // Find and click the chat/bubble view toggle
    const foundToggle = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        const text = (btn.textContent || '').toLowerCase();
        if (
          (ariaLabel.includes('chat') || title.includes('chat') || text.includes('chat') ||
           ariaLabel.includes('bubble') || title.includes('bubble') || text.includes('bubble') ||
           ariaLabel.includes('conversation') || title.includes('conversation')) &&
          btn.offsetHeight > 0
        ) {
          btn.click();
          return true;
        }
      }
      // Fallback: look for MessageCircle or similar icons
      const svgs = document.querySelectorAll('svg');
      for (const svg of svgs) {
        const parent = svg.closest('button');
        if (parent && parent.offsetHeight > 0) {
          const label = (parent.getAttribute('aria-label') || parent.getAttribute('title') || '').toLowerCase();
          if (label.includes('chat') || label.includes('bubble') || label.includes('conversation')) {
            parent.click();
            return true;
          }
        }
      }
      return false;
    });

    if (!foundToggle) {
      console.warn('[visual] Chat view toggle not found — skipping chat view baseline');
      this.skip();
      return;
    }

    await browser.pause(1000);
    await freezeDynamicContent();
    const result = await browser.checkScreen('chat-view', { misMatchPercentage: 0.5 });
    expect(result).toBeLessThanOrEqual(0.5);

    // Switch back to list view
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        const text = (btn.textContent || '').toLowerCase();
        if (
          (ariaLabel.includes('list') || title.includes('list') || text.includes('list') ||
           ariaLabel.includes('inbox') || title.includes('inbox')) &&
          btn.offsetHeight > 0
        ) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await browser.pause(300);
  });
});
