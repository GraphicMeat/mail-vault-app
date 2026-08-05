/**
 * E2E Test: Backup Settings Tab
 *
 * The settings restructure (e305123) renamed the tab to "Backup & Restore",
 * split it into three sub-tabs, and dropped the old Developer/"Coming Soon"
 * premium toggle — premium now comes from the billing profile, which a test
 * HOME has no way to set. So this covers navigation and rendering only.
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const BACKUP_TAB = 'Backup & Restore';

/**
 * Click a backup sub-tab. "Backup & Restore" names both the sidebar tab and the
 * first sub-tab, and the sub-tab bar renders after the sidebar — so the last
 * match is the sub-tab, the first would be the sidebar entry.
 */
async function clickBackupSubTab(label) {
  const clicked = await browser.execute((wanted) => {
    const matches = [...document.querySelectorAll('button')]
      .filter(b => b.offsetHeight > 0 && b.textContent.trim() === wanted);
    if (!matches.length) return false;
    matches[matches.length - 1].click();
    return true;
  }, label);
  await browser.pause(400);
  return clicked;
}

describe('Backup Settings', function () {
  this.timeout(60000);

  before(async function () {
    await waitForApp();
  });

  after(async function () {
    await closeSettings();
  });

  it('should navigate to Backup & Restore tab', async function () {
    await openSettings();
    await browser.pause(300);

    expect(await clickSettingsNav(BACKUP_TAB)).toBe(true);

    const hasContent = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('Backup Schedule') && text.includes('Backup Settings');
    });
    expect(hasContent).toBe(true);
  });

  it('should show backup schedule controls on the Schedule sub-tab', async function () {
    expect(await clickBackupSubTab('Backup Schedule')).toBe(true);

    const hasScheduleControls = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('Automatic Backup') || text.includes('Backup frequency');
    });
    expect(hasScheduleControls).toBe(true);
  });

  it('should navigate all backup sub-tabs without errors', async function () {
    for (const sub of ['Backup & Restore', 'Backup Settings', 'Backup Schedule']) {
      expect(await clickBackupSubTab(sub)).toBe(true);

      const hasError = await browser.execute(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('something went wrong') ||
          text.includes('error boundary') ||
          text.includes('unexpected error');
      });
      expect(hasError).toBe(false);
    }
  });

  it('should navigate to all settings tabs without errors', async function () {
    // Appearance is no longer top level — it is a sub-tab of General.
    const tabs = ['Accounts', 'Storage', BACKUP_TAB, 'Migration', 'Security', 'General', 'Appearance'];

    for (const tabName of tabs) {
      expect(await clickSettingsNav(tabName)).toBe(true);

      const hasError = await browser.execute(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('something went wrong') ||
          text.includes('error boundary') ||
          text.includes('unexpected error');
      });
      expect(hasError).toBe(false);
    }
  });
});
