/**
 * E2E Test: the settings path the docs print is the path the app has
 *
 * The changelog, the FAQ and one onboarding line all tell a reader to go to
 * Settings > General > Appearance > Highlighting. For a long time they said
 * Settings > Appearance, which names a top-level tab that does not exist:
 * Appearance is a sub-tab of General. A unit spec keeps the copy honest
 * (tests/unit/settingsPathCopy.test.js), but only the running app can say
 * whether the path itself is real.
 *
 * So this walks it, and pins the shape that made the old copy wrong: no
 * Appearance control until General is open.
 */

import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

/** Is a visible button carrying exactly this label on screen? */
const hasNav = (label) => browser.execute((wanted) =>
  [...document.querySelectorAll('button')]
    .some((b) => b.offsetHeight > 0 && b.textContent.trim() === wanted), label);

describe('The documented settings path', function () {
  this.timeout(90_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await openSettings();
  });

  after(async function () {
    // The next spec file boots into whatever this one leaves behind, Settings
    // included: an open Settings page hides the message list entirely.
    await closeSettings();
    await browser.pause(1000);
  });

  it('has no Appearance control while another top-level tab is open', async function () {
    // Storage is top level and its panel carries no sub-tabs, so an Appearance
    // button here would mean Appearance really is a top-level tab, which is
    // exactly what the old copy claimed.
    expect(await clickSettingsNav('Storage')).toBe(true);
    expect(await hasNav('Appearance')).toBe(false);
  });

  it('offers General at the top level', async function () {
    expect(await clickSettingsNav('General')).toBe(true);
  });

  it('reveals Appearance, Behavior, Notifications and Shortcuts under General', async function () {
    // One assertion over the whole set: wdio's expect takes no message
    // argument, so a per-item check would only ever say "false is not true".
    const subs = ['Appearance', 'Behavior', 'Notifications', 'Keyboard Shortcuts'];
    const present = {};
    for (const sub of subs) present[sub] = await hasNav(sub);
    expect(present).toEqual(Object.fromEntries(subs.map((s) => [s, true])));
  });

  it('ends at the Highlighting card, with both of its options', async function () {
    expect(await clickSettingsNav('Appearance')).toBe(true);
    const card = await browser.execute(() => {
      const hover = document.querySelector('[data-testid="row-highlight-hover"]');
      const selection = document.querySelector('[data-testid="row-highlight-selection"]');
      if (!hover || !selection) return null;
      // The heading of the card those two buttons live in, so the last segment
      // of the documented path is asserted by name and not only by testid.
      const heading = hover.closest('div.bg-mail-surface')?.querySelector('h4');
      return {
        visible: hover.offsetHeight > 0 && selection.offsetHeight > 0,
        heading: (heading?.textContent || '').trim(),
      };
    });
    expect(card).not.toBe(null);
    expect(card.visible).toBe(true);
    expect(card.heading).toBe('Highlighting');
  });
});
