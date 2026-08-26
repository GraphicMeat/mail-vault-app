/**
 * What the app is allowed to say about where a message lives.
 *
 * Two claims, one message, and they used to disagree on screen: a gold "your
 * only copy · deleted from the server" row under a green "saved in your vault ·
 * also still on the server" band. Both halves were wrong, in opposite
 * directions.
 *
 *  1. The ROW over-claimed. `local-only` was derived from the ACTIVE MAILBOX's
 *     uid set — "not in INBOX" printed as "not on the server". A message
 *     archived out of INBOX by Gmail, moved to a label, or sitting in the Bin
 *     is absent from that set and entirely alive. This file reproduces exactly
 *     that with a MOVE: the message leaves INBOX for the Bin, stays on the
 *     server, and the vault row must stay quiet.
 *
 *  2. The BAND could not reach the alarm at all. It read `source` off the
 *     viewer's own copy of the message (in-memory cache / vault `.eml` / server
 *     fetch), and every vault read stamps `source: 'local'`, so `local-only`
 *     was unreachable there by construction. It now reads the row the list
 *     derived — so the two claims are one claim.
 *
 * Both are asserted on two accounts, because the derivation is per-account and
 * the first version of this bug only showed up on a switch.
 *
 * Deliberately paired with connected-state-icons (amber is never rendered
 * without proof) and connected-bulk-delete-everywhere (amber IS rendered when
 * this app deletes the server copy). Neither of those watches the viewer.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

describe('Custody claims', function () {
  this.timeout(240000);

  const LUKE = 'luke@mock.test';
  // Account 3. Nothing else reads its folders, and its MOVE is deliberately
  // slow (4s) — which is the point: the row must not flash gold while the move
  // is on the wire either.
  const YODA = 'yoda@mock.test';

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  const rowFor = async (subject) => (await rows()).find((r) => r.text.includes(subject));

  const bandText = () => browser.execute(() =>
    document.querySelector('[data-testid="email-custody-band"]')?.innerText || null);

  const clickRowCheckbox = (subject) => browser.execute((needle) => {
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if (!(row.innerText || '').includes(needle)) continue;
      const box = row.querySelector('input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return true;
    }
    return false;
  }, subject);

  const openRow = (subject) => browser.execute((needle) => {
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if (!(row.innerText || '').includes(needle)) continue;
      row.click();
      return true;
    }
    return false;
  }, subject);

  const clickBarButton = (title) => browser.execute((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, title);

  /** Archive the named row through the selection bar, and wait for the vault glyph. */
  async function archive(subject) {
    expect(await clickRowCheckbox(subject)).toBe(true);
    expect(await clickBarButton('Archive selected')).toBe(true);
    await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('archived'), {
      timeout: 60_000, interval: 300,
      timeoutMsg: `"${subject}" never became an archived row`,
    });
  }

  /** Move the named row to the Bin — still on the server, just not in INBOX. */
  async function moveToBin(subject) {
    expect(await clickRowCheckbox(subject)).toBe(true);
    expect(await clickBarButton('Move to folder')).toBe(true);
    await browser.waitUntil(async () => browser.execute(() =>
      !!document.querySelector('[data-testid="move-to-folder-dropdown"]')), {
      timeout: 10_000, interval: 200, timeoutMsg: 'Move-to-folder dropdown never opened',
    });
    const picked = await browser.execute(() => {
      const dd = document.querySelector('[data-testid="move-to-folder-dropdown"]');
      for (const btn of dd.querySelectorAll('button')) {
        if (/^(Trash|Bin)$/i.test((btn.textContent || '').trim())) { btn.click(); return true; }
      }
      return false;
    });
    expect(picked).toBe(true);
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  after(async function () {
    try { await switchToFolder(LUKE, 'INBOX'); } catch { /* best effort */ }
  });

  /**
   * Every distinct icon this row shows while `action` runs, including states
   * that live for a single frame.
   *
   * Sampling, not a settled read: the false-gold state arrives LATE. The row
   * renders `archived` from the vault the moment the server row goes, and only
   * turns gold when the next full UID SEARCH comes back and the derivation sees
   * a uid the mailbox no longer lists. A single assertion after "it settled"
   * reads the honest frame and misses the lie that follows it — the first
   * version of this file passed against the unfixed app for exactly that reason.
   */
  async function iconsSeenFor(subject, ms) {
    const seen = new Set();
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        const r = await rowFor(subject);
        if (r?.icon) seen.add(r.icon);
      } catch { /* a sample taken mid-navigation loses the context; skip it */ }
    }
    return [...seen];
  }

  for (const [account, subjectRe] of [[LUKE, /Luke message \d+/], [YODA, /Yoda message \d+/]]) {
    describe(`${account}`, function () {
      it('keeps a vault row quiet — row and viewer — when the message only left the mailbox', async function () {
        await switchToFolder(account, 'INBOX');

        // The OLDEST rendered row, not the newest: yoda's three newest uids are
        // the fault fixtures (907 refuses its body, 908 is unreachable, 909
        // answers "no such uid"), and this test is about a healthy message.
        const candidates = (await rows()).filter((r) => subjectRe.test(r.text));
        expect(candidates.length).toBeGreaterThan(0);
        const subject = candidates[candidates.length - 1].text.match(subjectRe)[0];

        await archive(subject);
        await moveToBin(subject);

        // Prove the premise before asserting on it: the message really is out
        // of INBOX and really is still on the server, in the Bin. Without this
        // a move that silently failed would leave the row on the server list,
        // where it is green for the wrong reason.
        await switchToFolder(account, 'Trash');
        await browser.waitUntil(async () => !!(await rowFor(subject)), {
          timeout: 60_000, interval: 300,
          timeoutMsg: `"${subject}" never arrived in the Bin — the move did not land`,
        });

        // Reload before reading the claim. A move leaves the moved uid in the
        // session's merged uid set (loadEmails unions, it does not subtract),
        // so the in-session derivation can stay green by accident; the cold
        // path enumerates the mailbox afresh and marks the set complete. That
        // is the state a user actually sees — the app relaunched, and one row
        // in the list is gold.
        await browser.execute(() => window.location.reload());
        await waitForApp();
        await waitForEmails();
        await switchToFolder(account, 'INBOX');
        // The vault copy stays under INBOX and re-derives from the vault.
        await browser.waitUntil(async () => !!(await rowFor(subject))?.icon, {
          timeout: 60_000, interval: 300,
          timeoutMsg: `"${subject}" lost its vault row after the move`,
        });

        // Watch it across the reconcile, not once.
        const seen = await iconsSeenFor(subject, 6_000);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.filter((id) => id.startsWith('local-only'))).toEqual([]);
        expect(seen.some((id) => id.startsWith('archived'))).toBe(true);

        // And the viewer says the same about the same message.
        expect(await openRow(subject)).toBe(true);
        await browser.waitUntil(async () => !!(await bandText()), {
          timeout: 30_000, interval: 200, timeoutMsg: 'Custody band never rendered',
        });
        const band = await bandText();
        expect(band).toContain('Saved in your vault');
        // The contradiction, in the words it used to print.
        expect(band).not.toContain('only copy');
        expect(band).not.toContain('Deleted from the server');
      });
    });
  }

  describe('after this app deletes the server copy', function () {
    it('turns the row gold and has the viewer say so too', async function () {
      await switchToFolder(LUKE, 'INBOX');
      const candidates = (await rows()).filter((r) => /Luke message \d+/.test(r.text) && !r.icon?.startsWith('archived'));
      expect(candidates.length).toBeGreaterThan(0);
      const subject = candidates[candidates.length - 1].text.match(/Luke message \d+/)[0];

      await archive(subject);

      expect(await clickRowCheckbox(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      // The confirmation's own button, told apart from the bar's by the title
      // the bar buttons carry and the popover's do not.
      const confirmed = await browser.execute(() => {
        for (const btn of document.querySelectorAll('button')) {
          const label = (btn.textContent || '').trim();
          const isConfirm = label === 'Delete' || label === 'Delete from server';
          if (isConfirm && btn.offsetHeight > 0 && !btn.getAttribute('title')) { btn.click(); return true; }
        }
        return false;
      });
      expect(confirmed).toBe(true);

      await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('local-only'), {
        timeout: 60_000, interval: 500,
        timeoutMsg: `"${subject}" never became a local-only row after Delete from server`,
      });

      expect(await openRow(subject)).toBe(true);
      await browser.waitUntil(async () => !!(await bandText()), {
        timeout: 30_000, interval: 200, timeoutMsg: 'Custody band never rendered after the delete',
      });

      const band = await bandText();
      expect(band).toContain('only copy');
      // Says who removed it, and does not claim to speak for folders it never
      // looked in — the server may well still hold a copy in its own Bin.
      expect(band).toContain('You deleted the server copy');
      expect(band).not.toContain('Nothing else has it');
    });
  });
});
