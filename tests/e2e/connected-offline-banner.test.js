/**
 * Offline banner — the whole-app "no internet" surface.
 *
 * Real network state cannot be driven from a spec, and pulling the runner's
 * Wi-Fi would take the mock IMAP server down with it, so the app ships a mock
 * connectivity object under `VITE_E2E` (`window.__mvNet`) that pins the
 * verdict. Its presence is asserted first: without it every check below would
 * pass vacuously against an app that simply never went offline.
 *
 * What this proves that a unit test cannot: the banner is mounted in the real
 * App tree, and it is a BANNER — the message list stays on screen and stays
 * usable while it is up, which is the entire argument against a modal for a
 * local-first archive.
 */

import assert from 'node:assert';
import { waitForApp, waitForEmails, visibleRowSubjects } from './helpers.js';

const BANNER = '[data-testid="offline-banner"]';

const setOnline = (online) =>
  browser.execute((v) => {
    if (!window.__mvNet) return false;
    window.__mvNet.setOnline(v);
    return true;
  }, online);

const bannerShown = async () => (await $$(BANNER)).length > 0;

describe('offline banner', function () {
  it('appears while offline, leaves the mail readable, and clears on reconnect', async function () {
    this.timeout(120_000);

    await waitForApp();
    await waitForEmails();

    // The mock must exist, or every assertion below is vacuous.
    const hasMock = await browser.execute(() => Boolean(window.__mvNet));
    assert.ok(hasMock, 'window.__mvNet missing — is this a VITE_E2E build?');

    assert.equal(await bannerShown(), false, 'banner must not show while online');
    const subjectsBefore = await visibleRowSubjects();
    assert.ok(subjectsBefore.length > 0, 'need rows on screen to prove they survive');

    // ── Offline ──
    assert.ok(await setOnline(false), 'mock connectivity object refused setOnline');
    await browser.waitUntil(bannerShown, {
      timeout: 10_000,
      timeoutMsg: 'offline banner never appeared',
    });

    const text = await $(BANNER).getText();
    assert.match(text, /still here/i, 'banner must say the saved mail is still readable');

    // The point of a banner over a modal: nothing is blocked. Compare the
    // LEADING rows, not the whole set — the list is virtualized and the banner
    // costs it vertical space, so the render window legitimately holds one
    // row fewer while this is up. Demanding an identical set would be
    // asserting the virtualizer's arithmetic, not the archive's availability.
    const subjectsDuring = await visibleRowSubjects();
    assert.ok(subjectsDuring.length > 0, 'the message list emptied when the network dropped');
    assert.deepEqual(
      subjectsDuring.slice(0, 5),
      subjectsBefore.slice(0, 5),
      'the saved mail must still be on screen while offline — the archive is on disk'
    );

    // ── Back online ──
    assert.ok(await setOnline(true));
    await browser.waitUntil(async () => !(await bannerShown()), {
      timeout: 10_000,
      timeoutMsg: 'offline banner never cleared after reconnect',
    });

    // Leave the app pinned to nothing, so later specs in the suite get the
    // app's own verdict rather than this one's.
    await browser.execute(() => window.__mvNet?.release?.());
  });
});
