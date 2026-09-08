/**
 * E2E Test: Reading Pane, Mail View and Message Rows (UI-only)
 *
 * Verifies switching the workspace segments in Settings > Appearance > Layout
 * and the effect each one has on the app:
 * - Reading pane: Beside the list / Below the list
 * - Mail view: Email / Chat
 * - Message rows: Two lines / Single line
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

/** Open Settings on Appearance > Layout, where the workspace segments live. */
async function openLayoutSettings() {
  await openSettings();
  await clickSettingsNav('Appearance');
  await clickSettingsNav('Layout');
  await browser.pause(300);
}

/**
 * Click a workspace segment by its exact label.
 * Scrolls it into view first to handle off-screen options.
 * @param {string} label - The visible text of the segment to click
 * @returns {boolean} - Whether the segment was found and clicked
 */
async function clickSegment(label) {
  const clicked = await browser.execute((text) => {
    for (const btn of document.querySelectorAll('.settings-segments button')) {
      if (btn.offsetHeight > 0 && !btn.disabled && btn.textContent.trim() === text) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
        return true;
      }
    }
    return false;
  }, label);
  await browser.pause(300);
  return clicked;
}

/**
 * Read the selected state (aria-pressed) of a workspace segment.
 * @param {string} label - The visible text of the segment to check
 * @returns {boolean}
 */
function segmentPressed(label) {
  return browser.execute((text) => {
    for (const btn of document.querySelectorAll('.settings-segments button')) {
      if (btn.offsetHeight > 0 && btn.textContent.trim() === text) {
        return btn.getAttribute('aria-pressed') === 'true';
      }
    }
    return false;
  }, label);
}

/** Read one settings-store value, so the assertion names the stored choice. */

/**
 * Class name of the sidebar's visible sibling: the main content area, which is
 * flex-col in the stacked reading pane and flex-row beside the list.
 */
const mainAreaClassName = () => browser.execute(() => {
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  const parent = sidebar?.parentElement;
  if (!parent) return '';
  for (const child of parent.children) {
    if (child !== sidebar && child.offsetHeight > 0) return child.className;
  }
  return '';
});

describe('Reading Pane, Mail View & Message Rows', function () {
  this.timeout(30000);

  let appState;
  before(async function () {
    appState = await waitForApp();
    // The reading-pane and message-row segments are disabled in Chat, and the
    // e2e specs share one profile, so a neighbour may have left it there.
    // Through the UI, not a store seam: the CI build has no VITE_E2E seam.
    if (appState === 'ready') {
      await openLayoutSettings();
      if (!(await segmentPressed('Email'))) await clickSegment('Email');
      await closeSettings();
    }
  });

  // -----------------------------------------------------------------------
  // Reading Pane Switching
  // -----------------------------------------------------------------------
  describe('Reading Pane Switching', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
    });

    it('should move the reading pane below the list', async function () {
      await openLayoutSettings();

      const clicked = await clickSegment('Below the list');
      expect(clicked).toBe(true);
      expect(await segmentPressed('Below the list')).toBe(true);

      await closeSettings();

      // Verify the main content area uses flex-col (stacked reading pane)
      expect(await mainAreaClassName()).toContain('flex-col');
    });

    it('should move the reading pane back beside the list', async function () {
      await openLayoutSettings();

      const clicked = await clickSegment('Beside the list');
      expect(clicked).toBe(true);
      expect(await segmentPressed('Beside the list')).toBe(true);

      await closeSettings();

      // Verify the main content area uses flex-row (side-by-side reading pane)
      expect(await mainAreaClassName()).toContain('flex-row');
    });
  });

  // -----------------------------------------------------------------------
  // Message Row Switching
  // -----------------------------------------------------------------------
  describe('Message Row Switching', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
    });

    it('should switch to two-line rows', async function () {
      await openLayoutSettings();

      const clicked = await clickSegment('Two lines');
      expect(clicked).toBe(true);
      expect(await segmentPressed('Two lines')).toBe(true);

      await closeSettings();
    });

    it('should switch back to single-line rows', async function () {
      await openLayoutSettings();

      const clicked = await clickSegment('Single line');
      expect(clicked).toBe(true);
      expect(await segmentPressed('Single line')).toBe(true);

      await closeSettings();
    });
  });

  // -----------------------------------------------------------------------
  // Mail View Switching. Last: Chat disables the two groups above.
  // -----------------------------------------------------------------------
  describe('Mail View Switching', function () {
    before(async function () {
      if (appState !== 'ready') this.skip();
    });

    it('should switch to the Chat mail view', async function () {
      await openLayoutSettings();

      const clicked = await clickSegment('Chat');
      expect(clicked).toBe(true);
      expect(await segmentPressed('Chat')).toBe(true);

      await closeSettings();
    });

    it('should switch back to the Email mail view', async function () {
      await openLayoutSettings();

      const clicked = await clickSegment('Email');
      expect(clicked).toBe(true);
      expect(await segmentPressed('Email')).toBe(true);

      await closeSettings();
    });
  });
});
