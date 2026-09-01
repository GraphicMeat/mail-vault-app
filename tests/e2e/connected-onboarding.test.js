/**
 * E2E: the six-step onboarding tour (splash -> account -> appearance -> free
 * -> premium -> cta).
 *
 * Every OTHER spec boots with `onboardingComplete` seeded true (wdio.conf.js
 * `beforeSession`, the same way wdio.screenshots.conf.js already seeds it) so
 * the tour never shows and 58 unrelated spec files don't pay for it. This is
 * the one spec that clears the flag and actually walks it.
 *
 * Accounts already exist in the e2e fixture (wdio.conf.js's MOCK_ACCOUNTS),
 * so the account step is skipped and the flow is splash -> appearance -> free
 * -> premium -> cta. That skip is asserted explicitly below (waiting straight
 * for `appearance-preview`) rather than walked past — replay without
 * re-entering credentials is a headline behaviour of this redesign
 * (src/components/onboarding/steps.js: onboardingSteps).
 *
 * The tour runs in GERMAN here, and not incidentally: the layout defects this
 * spec guards against are all "the string is longer than the box", and German
 * is where the catalog's longest strings live. "Geplante automatische Backups"
 * is what stopped fitting the premium tile.
 */

import { waitForApp } from './helpers.js';

/**
 * Every piece of text inside `selector` that is cut off — by its own box, or by
 * the box it sits in.
 *
 * The second half is the one that matters and the one a naive check misses. The
 * defect this guards was `truncate` on a flex child: the span did NOT shrink and
 * clip itself, it grew to its full 202px inside a 196px tile, so
 * `scrollWidth === clientWidth === 202` and every self-overflow check passed
 * while the label was visibly cut in half. Proven by injecting the original
 * defect and watching a scrollWidth-only version of this helper stay green.
 *
 * So: compare each descendant's painted rect against the clipping box it lives
 * in, and keep the self-overflow test for the elements that do shrink.
 *
 * Measured in the page rather than from the host, because a clipped label has
 * the right text in the DOM and the wrong pixels — `getText()` can never see it.
 * The callback is sync and closes over nothing: `browser.execute` does not await
 * an async callback, and the page cannot reach host scope.
 */
async function clippedInside(selector) {
  return browser.execute((sel) => {
    const out = [];
    const say = (el, why) => {
      const t = (el.textContent || '').trim().slice(0, 60);
      if (t) out.push(`${t} (${why})`);
    };
    for (const root of document.querySelectorAll(sel)) {
      const box = root.getBoundingClientRect();
      for (const el of root.querySelectorAll('*')) {
        if (!(el.textContent || '').trim()) continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        // Escapes the container that is clipping it. 1px of slack for
        // sub-pixel layout and border rounding.
        if (r.right - box.right > 1 || r.bottom - box.bottom > 1 ||
            box.left - r.left > 1 || box.top - r.top > 1) {
          say(el, `escapes its container: ${Math.round(r.width)}px wide in ${Math.round(box.width)}px`);
          continue;
        }
        // Clips its own content (the case where the element did shrink).
        if (el.children.length === 0 &&
            (el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1)) {
          say(el, `clips itself: ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
        }
      }
    }
    return out;
  }, selector);
}

describe('onboarding', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
  });

  it('walks from the splash to the mailbox', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(false));
    await $('[data-testid="onboarding-splash"]').waitForExist({ timeout: 10000 });

    // Nothing precedes the splash, so there is nothing to go back to.
    expect(await $('[data-testid="onboarding-back"]').isExisting()).toBe(false);

    await $('[data-testid="onboarding-language-de"]').click();
    await $('[data-testid="onboarding-continue"]').click();

    // Accounts already exist in the e2e fixture, so the credentials step is
    // skipped and appearance is next.
    await $('[data-testid="appearance-preview"]').waitForExist({ timeout: 5000 });

    // Back lands on the splash, not on the step this replay never had.
    await $('[data-testid="onboarding-back"]').click();
    await $('[data-testid="onboarding-splash"]').waitForExist({ timeout: 5000 });
    await $('[data-testid="onboarding-continue"]').click();
    await $('[data-testid="appearance-preview"]').waitForExist({ timeout: 5000 });

    await $('[data-testid="appearance-layout-two-column"]').click();
    // Two-column stacks the reader under the list — it does not remove it.
    // App.jsx keeps the same reader in both layouts and only swaps the
    // container between row and column, and a preview that dropped the pane
    // told people the layout had nowhere to read a message.
    await $('[data-testid="preview-pane-viewer"]').waitForExist({ timeout: 5000 });
    const stacked = await browser.execute(() => {
      const panes = document.querySelector('[data-testid="preview-panes"]');
      const list = panes.querySelector('[data-testid="preview-list"]').getBoundingClientRect();
      const viewer = panes.querySelector('[data-testid="preview-pane-viewer"]').getBoundingClientRect();
      return { layout: panes.dataset.layout, below: viewer.top >= list.bottom - 1 };
    });
    expect(stacked.layout).toBe('two-column');
    expect(stacked.below).toBe(true);

    await $('[data-testid="onboarding-continue"]').click();

    // "Default email app" sits between appearance and the free features. The
    // row renders only once the backend has answered what the OS says, so wait
    // for its state rather than for the step container.
    await $('[data-testid="default-mail-state"]').waitForExist({ timeout: 5000 });
    await $('[data-testid="onboarding-continue"]').click();

    await $('[data-testid="free-feature-vault"]').waitForExist({ timeout: 5000 });
    // The claims that need explaining are icons, so each card carries the real
    // glyphs: the vault legend is LEGEND_ENTRIES, the same array the mail
    // list's own footer renders.
    for (const id of ['vault', 'chat', 'search', 'link-safety']) {
      // wdio's expect() takes exactly one argument — no message form.
      expect(await $(`[data-testid="free-sample-${id}"]`).isExisting()).toBe(true);
    }
    expect(await $('[data-testid="free-legend-legend-local-only"]').isExisting()).toBe(true);
    // The warnings card renders SAFETY_ALERTS — the app's own alert titles.
    // `safety-alert-*` replaced four labels the tour had invented for itself.
    expect(await $('[data-testid="safety-alert-sender-impersonation"]').isExisting()).toBe(true);
    expect(await $('[data-testid="safety-alert-tracker-blocked"]').isExisting()).toBe(true);
    expect(await clippedInside('[data-testid^="free-feature-"]')).toEqual([]);

    await $('[data-testid="onboarding-continue"]').click();

    await $('[data-testid="premium-tile-tracker-blocking"]').click();
    // Asset shipped AND cleared the CSP — a missing <img> makes this false, so
    // it cannot pass by absence. Waited for rather than read once: decoding is
    // not synchronous with the click, so reading immediately makes this assert
    // whatever the cache happened to have ready. A missing or blocked image
    // still fails, by timeout.
    await browser.waitUntil(
      async () => browser.execute(() => {
        const img = document.querySelector('[data-testid="premium-shot"]');
        return !!img && img.complete && img.naturalWidth > 0;
      }),
      { timeout: 5000, interval: 100, timeoutMsg: 'the premium screenshot never painted' },
    );

    await $('[data-testid="onboarding-continue"]').click();

    await $('[data-testid="onboarding-skip"]').click();
    await $('[data-testid="sidebar"]').waitForExist({ timeout: 15000 });
  });

  describe('the premium gallery', function () {
    beforeEach(async function () {
      // Close the tour first, then reopen it. `setOnboardingComplete(false)`
      // while the tour is already showing is a no-op for the step index —
      // Onboarding freezes its steps at mount — so a failed predecessor would
      // otherwise strand every following case wherever it stopped.
      await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(true));
      await $('[data-testid="sidebar"]').waitForExist({ timeout: 15000 });
      await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(false));
      await $('[data-testid="onboarding-splash"]').waitForExist({ timeout: 10000 });
      await $('[data-testid="onboarding-language-de"]').click();
      await $('[data-testid="onboarding-continue"]').click();
      await $('[data-testid="appearance-preview"]').waitForExist({ timeout: 5000 });
      await $('[data-testid="onboarding-continue"]').click();
      await $('[data-testid="default-mail-state"]').waitForExist({ timeout: 5000 });
      await $('[data-testid="onboarding-continue"]').click();
      await $('[data-testid="free-feature-vault"]').waitForExist({ timeout: 5000 });
      await $('[data-testid="onboarding-continue"]').click();
      await $('[data-testid="premium-tile-backup-schedule"]').waitForExist({ timeout: 5000 });
    });

    after(async function () {
      await browser.execute(() => window.__SETTINGS_STORE__.getState().setOnboardingComplete(true));
      await $('[data-testid="sidebar"]').waitForExist({ timeout: 15000 });
    });

    /**
     * The reported defect: "scheduled automatic backups — does not fit into
     * button". The label was `truncate`d to one line, so in every locale whose
     * translation runs past ~200px the feature name was cut mid-word and the
     * tile named nothing identifiable.
     *
     * Measured, not eyeballed: the text is in the DOM either way, so only the
     * box geometry can tell the difference.
     */
    it('fits every feature name inside its tile', async function () {
      expect(await clippedInside('[data-testid^="premium-tile-"]')).toEqual([]);
    });

    it('fits the longest name — the one that was reported — at its own tile', async function () {
      const tile = '[data-testid="premium-tile-backup-schedule"]';
      const label = await $(tile).getText();
      expect(label.length).toBeGreaterThan(0);
      expect(await clippedInside(tile)).toEqual([]);
    });

    it('keeps the tile column inside the gallery instead of pushing it sideways', async function () {
      const overflows = await browser.execute(() => {
        const col = document.querySelector('[data-testid="premium-tile-backup-schedule"]').parentElement;
        return col.scrollWidth - col.clientWidth > 1;
      });
      expect(overflows).toBe(false);
    });

    it('walks the catalog with previous and next, and wraps', async function () {
      const shown = () => $('[data-testid="premium-detail"]').getAttribute('data-feature');
      const first = await shown();

      await $('[data-testid="premium-next"]').click();
      expect(await shown()).not.toBe(first);

      await $('[data-testid="premium-prev"]').click();
      expect(await shown()).toBe(first);

      // Neither arrow is ever dead: back from the first wraps to the last.
      await $('[data-testid="premium-prev"]').click();
      expect(await shown()).not.toBe(first);
      await $('[data-testid="premium-next"]').click();
      expect(await shown()).toBe(first);
    });

    /**
     * The Continue button used to move under the pointer as you browsed,
     * because the detail column sized itself to whatever was showing.
     *
     * It must walk the WHOLE catalog. The first version of this test clicked
     * next four times and stayed green against the real defect: the only
     * feature whose box differed was `devices`, the tenth and the one with no
     * screenshot, so a partial sweep never reached the thing it was testing.
     */
    it('does not move the Continue button while browsing every feature', async function () {
      const total = await $$('[data-testid^="premium-tile-"]').length;
      expect(total).toBe(10);

      const seen = [], tops = [];
      for (let i = 0; i < total; i++) {
        const frame = await browser.execute(() => ({
          feature: document.querySelector('[data-testid="premium-detail"]').dataset.feature,
          // Sub-pixel: getLocation() rounds, and the defect was 12px but a
          // regression need not be.
          top: document.querySelector('[data-testid="onboarding-continue"]').getBoundingClientRect().top,
        }));
        seen.push(frame.feature);
        tops.push(frame.top);
        await $('[data-testid="premium-next"]').click();
      }

      // Proof the sweep was not vacuous: ten distinct features, including the
      // one with no screenshot.
      expect(new Set(seen).size).toBe(total);
      expect(seen).toContain('devices');
      expect(new Set(tops)).toEqual(new Set([tops[0]]));
    });

    it('opens the screenshot in a lightbox and closes it again', async function () {
      await $('[data-testid="premium-shot-zoom"]').click();
      await $('[data-testid="premium-lightbox-shot"]').waitForExist({ timeout: 5000 });

      // The enlarged image is a real, painted image — not the same broken-asset
      // trap the inline shot is already guarded against.
      const big = await browser.execute(() => {
        const img = document.querySelector('[data-testid="premium-lightbox-shot"]');
        const small = document.querySelector('[data-testid="premium-shot"]');
        return {
          painted: !!img && img.complete && img.naturalWidth > 0,
          bigger: !!img && !!small && img.getBoundingClientRect().width > small.getBoundingClientRect().width,
        };
      });
      expect(big.painted).toBe(true);
      expect(big.bigger).toBe(true);

      await $('[data-testid="premium-lightbox-close"]').click();
      await $('[data-testid="premium-lightbox-shot"]').waitForExist({ timeout: 5000, reverse: true });
    });
  });
});
