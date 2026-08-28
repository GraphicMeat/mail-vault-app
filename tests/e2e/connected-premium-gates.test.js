/**
 * E2E: what a subscription actually unlocks.
 *
 * Written after 2026-08-27, when automatic backups turned out to run for anyone
 * who flipped one ungated switch. The per-account backup card was gated, so
 * every audit of "is backup premium?" that looked at the surface carrying the
 * upsell said yes. Nothing checked the other surfaces at all.
 *
 * So this walks every premium surface in the shipped UI and asserts both
 * directions: locked for a free profile, open with premium. A gate that goes
 * missing the way the backup one did now fails here.
 *
 * Two gate STYLES exist and they need different assertions:
 *   - early return (Email Cleanup, Time Capsule) — the real UI is not rendered
 *   - blur overlay (Migration, Backup, Storage) — the real UI IS in the DOM,
 *     behind `opacity-30 blur-[1px] pointer-events-none` and an overlay. Its
 *     text is therefore present while locked, so "the feature text is showing"
 *     proves nothing. The lock marker is what gets asserted, in both directions.
 *
 * Three accounts are seeded and every case runs with all of them present: the
 * backup and migration screens render per-account rows, and a single-account
 * run would not exercise that.
 */

import { waitForApp, closeSettings } from './helpers.js';
import { setPremium, setShareGrant, seedSignedOut, openTab, settingsText } from './mockBilling.js';

/**
 * One entry per premium surface. `lock` is text that appears ONLY in the locked
 * state; `tab` is the Settings nav label, which doubles as proof the tab
 * rendered at all — an absent lock string means nothing if the page is blank.
 */
const SURFACES = [
  {
    tab: 'Email Cleanup',
    lock: 'Email Cleanup is a Premium Feature',
    style: 'early-return',
  },
  {
    tab: 'Time Capsule',
    lock: 'Time Capsule is a Premium Feature',
    style: 'early-return',
  },
  {
    tab: 'Tracker Blocking',
    // Neither style above: the demonstration (before/after, the beacon's own
    // markup) renders for everyone — selling the feature is what the page is
    // for. Only the upsell card and the switch swap places.
    lock: 'Tracker Blocking is a Premium Feature',
    style: 'upsell-card',
  },
  {
    tab: 'Migration',
    lock: 'Mailbox migration lets you move emails between any two providers',
    style: 'blur-overlay',
  },
  {
    tab: 'Backup & Restore',
    // The tab opens on Backup Settings (export/import), which has no gate.
    subTab: 'Backup Schedule',
    lock: 'Schedule automatic backups to keep your emails safe',
    style: 'blur-overlay',
  },
];

/** Does the Auto-Cleanup card on the Storage tab show its blurred fake preview? */
const storageAutoCleanupLocked = () => browser.execute(() => {
  const card = document.querySelector('[data-testid="settings-auto-cleanup"]');
  if (!card) return null;
  return !!card.querySelector('[aria-hidden="true"].pointer-events-none');
});

describe('Premium gates — what a subscription actually unlocks', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    // The backup and migration screens list accounts; one account would not
    // exercise the per-account rendering these gates sit inside.
    expect(browser.mockAccounts.length).toBeGreaterThan(1);
  });

  after(async function () {
    await closeSettings().catch(() => {});
    await seedSignedOut();
  });

  describe('locked for a free profile', function () {
    beforeEach(async () => { await setPremium(false); });

    for (const s of SURFACES) {
      it(`${s.tab} shows its ${s.style} lock`, async function () {
        await openTab(s.tab, s.subTab);
        const text = await settingsText();
        // Positive control: the tab really rendered. Without it, a blank panel
        // would satisfy the premium half of this pair for free.
        expect(text).toContain(s.tab.split(' ')[0]);
        expect(text).toContain(s.lock);
      });
    }

    it('Storage blurs the Auto-Cleanup rules behind a Premium badge', async function () {
      await openTab('Storage');
      expect(await storageAutoCleanupLocked()).toBe(true);
    });
  });

  describe('open with premium', function () {
    beforeEach(async () => { await setPremium(true); });

    for (const s of SURFACES) {
      it(`${s.tab} drops its lock`, async function () {
        await openTab(s.tab, s.subTab);
        const text = await settingsText();
        expect(text).toContain(s.tab.split(' ')[0]);
        expect(text).not.toContain(s.lock);
      });
    }

    it('Storage shows the real Auto-Cleanup rules', async function () {
      await openTab('Storage');
      expect(await storageAutoCleanupLocked()).toBe(false);
    });
  });

  /**
   * The share-to-unlock reward is premium with no subscription and no sign-in:
   * `hasPremiumAccess` returns true for the grant window before it ever looks at
   * the billing profile. It is the path by which someone who has never signed in
   * reaches these screens — and by which they lose them again, silently, when
   * the window closes.
   */
  describe('share-to-unlock grant', function () {
    afterEach(async () => { await setShareGrant(null); });

    it('opens every gate with no subscription anywhere', async function () {
      await setPremium(false);
      await setShareGrant(60 * 60_000);
      for (const s of SURFACES) {
        await openTab(s.tab, s.subTab);
        expect(await settingsText()).not.toContain(s.lock);
      }
    });

    it('closes them again the moment it expires', async function () {
      await setPremium(false);
      await setShareGrant(-1000);
      for (const s of SURFACES) {
        await openTab(s.tab, s.subTab);
        expect(await settingsText()).toContain(s.lock);
      }
    });
  });
});
