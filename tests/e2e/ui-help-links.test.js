/**
 * E2E Test: Help & Support product links (UI-only)
 *
 * A user reported that Help > "MailVault Website" opened mailvault.app, which
 * is offline. The live site is mailvaultapp.com. The same panel also carries
 * the cross-sell link to the other GraphicMeat products.
 *
 * The buttons are never clicked here — a click launches the real browser on the
 * test machine. The URL each button carries is asserted instead, which is the
 * part that regressed.
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

describe('Help & Support links', function () {
  this.timeout(30000);
  let settingsAccessible = false;

  before(async function () {
    await waitForApp();
    try {
      await openSettings();
      settingsAccessible = true;
      await closeSettings();
    } catch {
      settingsAccessible = false;
    }
  });

  after(async function () {
    await closeSettings();
  });

  describe('Help & Support tab', function () {
    before(async function () {
      if (!settingsAccessible) this.skip();
      await openSettings();
      await browser.pause(300);
      await clickSettingsNav('Help & Support');
    });

    after(async function () {
      await closeSettings();
    });

    const rowUrl = (testid) => browser.execute((id) => {
      const row = document.querySelector(`[data-testid="${id}"]`);
      if (!row || row.offsetHeight === 0) return null;
      const button = row.querySelector('button[data-url]');
      return button ? { url: button.dataset.url, text: row.innerText } : null;
    }, testid);

    it('points the website link at the live domain', async function () {
      const row = await rowUrl('settings-link-website');
      expect(row).not.toBe(null);
      expect(row.url).toBe('https://mailvaultapp.com');
      expect(row.url).not.toContain('mailvault.app');
    });

    it('offers a link to the other GraphicMeat products', async function () {
      const row = await rowUrl('settings-link-more-apps');
      expect(row).not.toBe(null);
      expect(row.url).toBe('https://graphicmeat.com');
      expect(row.text).toContain('GraphicMeat');
    });

    it('leaves the existing Report Bug action in place', async function () {
      const hasReportBug = await browser.execute(() => {
        for (const btn of document.querySelectorAll('button')) {
          if (btn.offsetHeight > 0 && btn.textContent.trim() === 'Report Bug') return true;
        }
        return false;
      });
      expect(hasReportBug).toBe(true);
    });
  });
});
