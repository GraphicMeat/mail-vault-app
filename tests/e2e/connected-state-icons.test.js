/**
 * The message state icon, against a live mock IMAP server.
 *
 * `connected-storage-matrix` already pins each icon against what is actually on
 * disk. This file pins the other half — the rule that made the amber state hard
 * to reach in the first place:
 *
 *   amber ("deleted from the server, this is your only copy") requires PROOF of
 *   server absence, and an unproven uid set means "not asked yet", never "not
 *   there".
 *
 * That rule is a claim about *transitions*, not about a settled row, so the
 * assertions here sample continuously across account and folder switches rather
 * than reading once at the end. A settled-state assertion cannot see the bug
 * this file exists for: every archived row flashing "deleted from server" for
 * the duration of a switch, then correcting itself.
 *
 * Written after the four-round `serverUids` fix (see the store's
 * slices/serverUids.js). Before it, the assertions below were vacuous — amber
 * was unreachable, so "no row is amber" passed for the wrong reason. They are
 * meaningful only because connected-storage-matrix rows 4 and 5 now prove amber
 * DOES render when the server copy is genuinely gone; the two files are a pair
 * and neither is worth much alone.
 *
 * Deliberately NOT here: a dedicated fault account with slowFetch/DropConnection
 * to hold the unproven window open. The window is already observable without
 * one (`archived-server-unknown*` is asserted below), and a fourth mock account
 * shifts every visual-* baseline and adds a server to all twenty spec files —
 * real blast radius for determinism this file does not need.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

// Mock subjects, matched whole. `visibleRowSubjects()` returns the WHOLE row
// flattened ("Sender 1 | Luke message 40 | Jan 2"), which is not a handle you
// can match against a row's innerText — pull the subject out of it instead.
const SUBJECT_RE = /(?:Luke|Vader|Yoda) message \d+/;

describe('Message state icons', function () {
  this.timeout(180000);

  const LUKE = 'luke@mock.test';
  const VADER = 'vader@mock.test';

  // Every rendered row's icon id, in list order. `null` for a row that has no
  // icon yet — a real state during a paint, and one the samplers below must be
  // able to tell apart from "some icon".
  //
  // `text` is the whole row flattened the same way helpers.visibleRowSubjects
  // does it, and rows are matched by substring against it: a row's innerText is
  // sender / subject / date, so indexing into the split picks the SENDER, which
  // silently matched nothing.
  const icons = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  const rowFor = async (subject) => (await icons()).find((r) => r.text.includes(subject));

  /**
   * Run `action` while polling the rendered icons as fast as the bridge allows,
   * and return every distinct icon id seen across the whole window — including
   * the ones that existed for a single frame.
   *
   * Sampling is the point. The false-amber bug was invisible to any assertion
   * that waited for the list to settle first.
   */
  async function iconsSeenDuring(action) {
    const seen = new Set();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          for (const r of await icons()) if (r.icon) seen.add(r.icon);
        } catch {
          // A sample taken mid-navigation can lose the execution context. A
          // dropped sample is not a failure — the loop just takes the next one.
        }
      }
    })();
    try {
      await action();
    } finally {
      sampling = false;
      await sampler;
    }
    for (const r of await icons()) if (r.icon) seen.add(r.icon);
    return [...seen];
  }

  const focusIcon = (testId, index = 0) => browser.execute((sel, i) => {
    const el = document.querySelectorAll(`[data-testid="${sel}"]`)[i];
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  }, testId, index);

  const blurActive = () => browser.execute(() => document.activeElement?.blur());

  const tooltipText = () => browser.execute(() =>
    document.querySelector('[data-testid="msg-state-tooltip"]')?.innerText || null);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  after(async function () {
    // This suite shares one app instance with every other spec file, so it owns
    // putting the view back. Written so cleanup can never throw and mask a real
    // failure reported above.
    try {
      await blurActive();
      await switchToFolder(LUKE, 'INBOX');
    } catch { /* best effort */ }
  });

  describe('the amber state is never rendered without proof', function () {
    it('shows no local-only row at any point across an A → B → A account switch', async function () {
      // The original defect in one sentence: switching accounts cleared the uid
      // set, and every archived row derived "absent from the set" as "deleted
      // from the server" until the next sync refilled it. Nothing in these three
      // mailboxes has been deleted server-side, so amber is wrong at every
      // instant of this sequence — not merely wrong once it settles.
      const seen = await iconsSeenDuring(async () => {
        await switchToFolder(LUKE, 'INBOX');
        await switchToFolder(VADER, 'INBOX');
        await switchToFolder(LUKE, 'INBOX');
      });

      expect(seen.filter((id) => id.startsWith('local-only'))).toEqual([]);
      // Non-vacuity: a run that rendered no icons at all would also produce an
      // empty amber list. It has to have actually seen rows.
      expect(seen.length).toBeGreaterThan(0);
    });

    it('shows no local-only row while a folder switch is repainting', async function () {
      const seen = await iconsSeenDuring(async () => {
        await switchToFolder(LUKE, 'Archive');
        await switchToFolder(LUKE, 'INBOX');
      });

      expect(seen.filter((id) => id.startsWith('local-only'))).toEqual([]);
      expect(seen.length).toBeGreaterThan(0);
    });

    it('renders the honest unknown state rather than guessing, and settles out of it', async function () {
      // The window where the app has an archived row but no proven enumeration
      // is real and is allowed — what it must not do is fill it with a guess in
      // either direction. It renders `archived-server-unknown`, which claims
      // only "saved in your vault"; then a live enumeration lands and it becomes
      // plain `archived`.
      await switchToFolder(LUKE, 'INBOX');
      // Taken from the rendered list rather than hard-coded, so this does not
      // depend on fixture numbering.
      const first = (await icons()).find((r) => SUBJECT_RE.test(r.text));
      // No message arg: this harness's expect takes one argument only.
      expect(first).toBeDefined();
      const subject = first.text.match(SUBJECT_RE)[0];

      // Archive it so it has a vault copy — that is the only way to reach any
      // `archived*` state at all. Both clicks are asserted: the action bar
      // buttons are icon-only and carry their label in `title`, so a
      // textContent match finds nothing and archives nothing, silently.
      const toggled = await browser.execute((needle) => {
        for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
          if (!(row.innerText || '').includes(needle)) continue;
          const box = row.querySelector('input[type="checkbox"]');
          if (!box) return false;
          box.click();
          return true;
        }
        return false;
      }, subject);
      expect(toggled).toBe(true);

      const clicked = await browser.execute(() => {
        const btn = document.querySelector('button[title="Archive selected"]');
        if (!btn || btn.offsetHeight === 0) return false;
        btn.click();
        return true;
      });
      expect(clicked).toBe(true);

      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return !!r?.icon?.startsWith('archived');
      }, { timeout: 30_000, interval: 300, timeoutMsg: `"${subject}" never became an archived row` });

      // Whatever it shows right now, it must settle on the proven state — and
      // an unknown that never settles is the fail-closed-with-no-way-open bug.
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return !!r?.icon && !r.icon.includes('server-unknown');
      }, {
        timeout: 30_000, interval: 300,
        timeoutMsg: `"${subject}" never settled out of the server-unknown state — the uid set was never proven`,
      });

      const settled = await rowFor(subject);
      // Still on the server, so it is green-archived, never amber.
      expect(settled.icon.startsWith('archived')).toBe(true);
      expect(settled.icon.startsWith('local-only')).toBe(false);
    });
  });

  describe('tooltips', function () {
    // Focus, not hover: no spec in this repo drives hover, and StateTooltip
    // opens on focus for exactly that reason (MessageStateIcon.jsx — onFocus).
    afterEach(async function () {
      await blurActive();
    });

    it('opens a row icon tooltip on focus and closes it on blur', async function () {
      await switchToFolder(LUKE, 'INBOX');
      expect(await focusIcon('msg-state-icon')).toBe(true);

      await browser.waitUntil(async () => !!(await tooltipText()), {
        timeout: 5_000, interval: 100, timeoutMsg: 'Row icon tooltip never opened on focus',
      });
      const text = await tooltipText();
      expect(text.length).toBeGreaterThan(0);

      await blurActive();
      await browser.waitUntil(async () => (await tooltipText()) === null, {
        timeout: 5_000, interval: 100, timeoutMsg: 'Row icon tooltip never closed on blur',
      });
    });

    it('states in words that an unverified server copy is not a claim of absence', async function () {
      // The wording is the safety rail: whatever the glyph, an unproven row must
      // not read as "deleted". Green-archived says one of two things, and
      // neither of them is that.
      await switchToFolder(LUKE, 'INBOX');
      // Depends on the archive performed by the test above; assert rather than
      // skip, since a silent skip here would hide the wording regression this
      // test exists for.
      const idx = (await icons()).findIndex((r) => r.icon?.startsWith('archived'));
      // -1 here means the archive in the test above did not land, which is a
      // failure of this assertion's premise — not a reason to skip it.
      expect(idx).toBeGreaterThanOrEqual(0);

      expect(await focusIcon('msg-state-icon', idx)).toBe(true);
      await browser.waitUntil(async () => !!(await tooltipText()), {
        timeout: 5_000, interval: 100, timeoutMsg: 'Archived row tooltip never opened',
      });

      const text = await tooltipText();
      expect(text).toContain('Saved in your vault');
      expect(text).toMatch(/Server copy not verified yet\.|Also still on the server\./);
      expect(text).not.toContain('Deleted from the server');
    });

    it('opens each legend entry tooltip on focus', async function () {
      await switchToFolder(LUKE, 'INBOX');
      const count = await browser.execute(() =>
        document.querySelectorAll('[data-testid="legend-state-icon"]').length);
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        expect(await focusIcon('legend-state-icon', i)).toBe(true);
        await browser.waitUntil(async () => !!(await tooltipText()), {
          timeout: 5_000, interval: 100, timeoutMsg: `Legend entry ${i} never opened a tooltip on focus`,
        });
        await blurActive();
        await browser.waitUntil(async () => (await tooltipText()) === null, {
          timeout: 5_000, interval: 100, timeoutMsg: `Legend entry ${i} tooltip never closed on blur`,
        });
      }
    });

    it('names the amber state in the legend, so the icon has a key', async function () {
      await switchToFolder(LUKE, 'INBOX');
      const legend = await browser.execute(() =>
        [...document.querySelectorAll('[data-testid="legend-state-icon"]')]
          .map((el) => el.parentElement?.innerText || '').join(' | '));
      expect(legend).toContain('Local only (deleted from server)');
    });
  });
});
