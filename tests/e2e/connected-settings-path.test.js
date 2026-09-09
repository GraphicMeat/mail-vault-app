/**
 * Appearance is a direct Settings destination. Walk its current navigation
 * and verify that Reading exposes both message-highlighting choices.
 */

import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

/** Is a visible button carrying exactly this label on screen? */
const hasNav = (label) => browser.execute((wanted) =>
  [...document.querySelectorAll('[data-testid="settings-page"] .settings-nav-item')]
    .some((b) => b.offsetHeight > 0 && b.textContent.trim() === wanted), label);

describe('Settings appearance navigation', function () {
  this.timeout(90_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await openSettings();
  });

  after(async function () {
    await closeSettings();
    await browser.pause(1000);
  });

  it('keeps Appearance available while another Settings page is open', async function () {
    expect(await clickSettingsNav('Storage')).toBe(true);
    expect(await hasNav('Appearance')).toBe(true);
    expect(await browser.execute(() => document.querySelector('[data-testid="settings-content"]')?.dataset.page)).toBe('storage');
  });

  it('opens Appearance directly from the sidebar', async function () {
    expect(await clickSettingsNav('Appearance')).toBe(true);
    expect(await browser.execute(() => document.querySelector('[data-testid="settings-content"]')?.dataset.page)).toBe('appearance');
  });

  it('offers Colors, Layout, Reading and Date & time sections', async function () {
    const sections = await browser.execute(() => [...document.querySelectorAll('[data-testid="settings-content"] [role="tab"]')]
      .filter(tab => tab.offsetHeight > 0).map(tab => tab.textContent.trim()));
    expect(sections).toEqual(['Colors', 'Layout', 'Reading', 'Date & time']);
  });

  it('exposes both Highlighting options under Reading with an associated label', async function () {
    expect(await clickSettingsNav('Reading')).toBe(true);
    const control = await browser.execute(() => {
      const label = [...document.querySelectorAll('[data-testid="settings-content"] label')]
        .find(element => element.textContent.trim() === 'Highlighting');
      const select = label?.control;
      if (!select) return null;
      return {
        visible: select.offsetHeight > 0,
        options: [...select.options].map(option => [option.value, option.textContent.trim()]),
      };
    });
    expect(control).toEqual({ visible: true, options: [
      ['hover', 'Follow the pointer'], ['selection', "Mark what I'm reading"],
    ] });
  });
});
