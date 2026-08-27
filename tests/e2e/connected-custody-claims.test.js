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

import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { MOCK_PASSWORD } from './mockImap.js';

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

  const clickCheckServer = () => browser.execute(() => {
    const btn = document.querySelector('[data-testid="custody-check-server"]');
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  });

  const checkResult = () => browser.execute(() =>
    document.querySelector('[data-testid="custody-check-result"]')?.innerText || null);

  /**
   * Delete a message from the mock server with our own IMAP connection —
   * behind the app's back, which is the whole point. Every other way of losing
   * a server copy in this suite goes through the app, and the app stamps
   * `serverDeleted` when it does; this is the case nobody told the app about,
   * and the only evidence available afterwards is a sweep of the folders.
   */
  async function expungeBehindTheApp(serverIndex, user, mailbox, subject) {
    const { host, port } = browser.mockImap[serverIndex];
    const client = new ImapFlow({
      host, port, secure: false, auth: { user, pass: MOCK_PASSWORD }, logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = await client.search({ subject }, { uid: true });
      expect(uids.length).toBeGreaterThan(0);
      await client.messageDelete(uids, { uid: true });
      // Prove it actually went, or the assertion below would pass on a delete
      // that never happened AND on a probe that never looked.
      expect(await client.search({ subject }, { uid: true })).toEqual([]);
    } finally {
      lock.release();
      await client.logout();
    }
  }

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

  /**
   * Archive ONE row through its own hover button — a different workflow from
   * `archive()` below, and the distinction matters.
   *
   * The selection bar routes to `saveEmailsLocally`, which rebuilds
   * `localEmails` from `readLocalEmailIndex` and therefore carries custody by
   * construction. The row's own button routes to `saveEmailLocally`, which
   * rebuilds from the vault files. Only the second could drop the stamp, so
   * only the second proves anything about it.
   *
   * The button lives in a `group-hover:visible` strip — `visibility: hidden`,
   * so it has a box and takes a synthetic click without a real hover.
   */
  async function archiveRowButton(subject) {
    const clicked = await browser.execute((needle) => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (!(row.innerText || '').includes(needle)) continue;
        const btn = row.querySelector('button[title="Archive"]');
        if (!btn) return false;
        btn.click();
        return true;
      }
      return false;
    }, subject);
    expect(clicked).toBe(true);
    await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('archived'), {
      timeout: 60_000, interval: 300,
      timeoutMsg: `"${subject}" never became an archived row after the row's own Archive button`,
    });
  }

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

  /**
   * "Is this Message-ID anywhere?" — the question the gold colour was written
   * for, asked of the server across every folder.
   *
   * The pair below is the whole feature. The first case is the one that used to
   * be got wrong: a message that left INBOX and is alive in the Bin. Nothing
   * derived from a mailbox can tell it apart from a message someone deleted for
   * good, which is why gold was withdrawn from both. The second is the case the
   * withdrawal cost: a server copy destroyed by somebody else, discoverable
   * only by looking in every folder and finding none.
   *
   * Run them in this order and the first is a negative control for the second —
   * a probe that only ever searched INBOX would report the Bin message absent
   * and fail here, before it got the chance to pass there for the wrong reason.
   */
  describe('asking the server about every folder', function () {
    // Carried between the last two cases: the reload has to bring back the
    // verdict for THIS message, not merely find some gold row somewhere.
    let sweptSubject = null;

    /**
     * The quiet vault row the first case in this file already left behind:
     * archived here, server copy moved to the Bin, verdict re-derived after a
     * reload. Reused rather than made again — `saveEmailLocally` fails outright
     * for a message the vault has already cached ("Email UID N not found in
     * Maildir": `isEmailSaved` says yes off `maildir_exists`, `archiveEmail`
     * says no off `maildir_list`), and by the seventh case of a session most
     * rows are cached. That bug is not this feature's, and reproducing it here
     * would only hide the sweep.
     *
     * `archived*`, not "not server-only": by now one LUKE row is gold, and
     * `local-only` is an archived state whose id does not begin with "archived".
     */
    async function binnedVaultRow(account, subjectRe) {
      await switchToFolder(account, 'INBOX');
      const row = (await rows()).find((r) => subjectRe.test(r.text) && r.icon?.startsWith('archived'));
      expect(`${row?.text}`).toMatch(subjectRe);
      return row.text.match(subjectRe)[0];
    }

    async function openAndCheck(subject) {
      expect(await openRow(subject)).toBe(true);
      await browser.waitUntil(async () => !!(await bandText()), {
        timeout: 30_000, interval: 200, timeoutMsg: 'Custody band never rendered',
      });
      expect(await clickCheckServer()).toBe(true);
      await browser.waitUntil(async () =>
        !!(await checkResult()) || !!(await bandText())?.includes('only copy'), {
        timeout: 60_000, interval: 300, timeoutMsg: 'The server check never came back',
      });
    }

    it('finds the copy the mailbox lost, in the folder that has it', async function () {
      const subject = await binnedVaultRow(LUKE, /Luke message \d+/);
      await openAndCheck(subject);

      // The sweep visited the Bin. A probe scoped to the active mailbox — the
      // derivation this whole feature replaces — would have said "absent".
      const note = await checkResult();
      expect(`${note}`).toContain('Still on the server');
      expect(`${note}`).toMatch(/Trash|Bin/i);
      const band = await bandText();
      expect(band).toContain('Saved in your vault');
      expect(band).not.toContain('only copy');
    });

    it('turns the row gold when someone else deleted the server copy', async function () {
      // A second account, because the claim is per-account and the first
      // version of this bug only appeared on a switch.
      const subject = await binnedVaultRow(YODA, /Yoda message \d+/);
      sweptSubject = subject;

      // Now take it off the server without telling the app. No `serverDeleted`
      // stamp exists for this — the app was never asked to delete anything.
      // The Bin is where the first case in this file left the server copy.
      await expungeBehindTheApp(2, YODA, 'Trash', subject);

      await openAndCheck(subject);

      await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('local-only'), {
        timeout: 60_000, interval: 300,
        // The probe reports WHY it could not answer; print it, or a red here
        // says only "not gold" and the next run is another nine minutes.
        timeoutMsg: `"${subject}" never went gold after the sweep — the band said `
          + `${JSON.stringify(await bandText())}, the check said ${JSON.stringify(await checkResult())}`,
      });

      const band = await bandText();
      expect(band).toContain('only copy');
      // The sentence the colour was written for — and it may say "nothing else
      // has it" here, unlike the app's own delete, because the sweep looked in
      // All Mail, the Bin and every other folder before saying so.
      expect(band).toContain('Someone else deleted the server copy');
      expect(band).toContain('Nothing else has it');
    });

    it('keeps the verdict across a reload — it is on disk, not in the session', async function () {
      // The stamp lives on the vault's index entry. An in-memory one would die
      // with the session and the row would go quiet on the next launch, which
      // is the same silence the original bug produced.
      await browser.execute(() => window.location.reload());
      await waitForApp();
      await waitForEmails();
      await switchToFolder(YODA, 'INBOX');

      expect(sweptSubject).toBeTruthy();
      const gold = await browser.waitUntil(async () => {
        const row = await rowFor(sweptSubject);
        return row?.icon?.startsWith('local-only') ? row : false;
      }, {
        timeout: 60_000, interval: 300,
        timeoutMsg: `"${sweptSubject}" did not come back gold after a reload`,
      });
      expect(gold.icon).toMatch(/^local-only/);
    });

    /**
     * A proof belongs to one message, and archiving a DIFFERENT one must not
     * spend it.
     *
     * Every workflow that writes the vault rebuilds `localEmails` for the whole
     * mailbox afterwards, and `custodySource` derives the row's colour from
     * `_origin` / `serverDeleted` / `serverAbsent` on those very rows. The
     * rebuild used to come from bare `db.getLocalEmails`, which builds rows out
     * of `.eml` headers and knows nothing about local-index.json — so one
     * archive re-derived every other row in the mailbox as an ordinary vault
     * copy and the gold went out, silently, until something else happened to
     * call `getArchivedEmails`.
     *
     * It has to be `archiveRowButton`, not `archive`: the selection bar's bulk
     * path reads the index first and was never capable of losing the stamp.
     * The first version of this case used the bar and passed against the bug.
     *
     * Placed last on purpose: it needs a mailbox that already holds a row with
     * real proof behind it, and the sweep above just left one.
     */
    it('does not spend that verdict when the next message is archived', async function () {
      expect(sweptSubject).toBeTruthy();
      await switchToFolder(YODA, 'INBOX');

      // The oldest rendered message that is neither the gold row nor already
      // in the vault — oldest for the same reason the first case in this file
      // takes the oldest, and not-yet-archived because `saveEmailLocally`
      // fails outright on a message the vault has already cached.
      const subjectOf = (r) => r.text.match(/Yoda message \d+/)?.[0] || null;
      const fresh = (await rows()).filter((r) => {
        const s = subjectOf(r);
        return s && s !== sweptSubject && !r.icon?.startsWith('archived') && !r.icon?.startsWith('local-only');
      });
      expect(fresh.length).toBeGreaterThan(0);
      await archiveRowButton(subjectOf(fresh[fresh.length - 1]));

      // Sampled across the re-derivation rather than read once after it: the
      // quiet frame arrives WITH the rebuilt list, so a single settled read
      // taken a moment later can miss it entirely.
      const seen = await iconsSeenFor(sweptSubject, 6_000);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((id) => !id.startsWith('local-only'))).toEqual([]);

      // And the viewer agrees, from the same rows the list derived.
      expect(await openRow(sweptSubject)).toBe(true);
      await browser.waitUntil(async () => !!(await bandText()), {
        timeout: 30_000, interval: 200, timeoutMsg: 'Custody band never rendered after the second archive',
      });
      expect(await bandText()).toContain('only copy');
    });
  });
});
