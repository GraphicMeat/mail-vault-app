/**
 * E2E: an auto-cleanup rule may only delete a server copy it can prove is here.
 *
 * The bug this pins (b29414c9): a rule deleted mail from the server that it
 * had never managed to save. `archive_emails` was invoked with the account
 * under the wrong argument name so every call was rejected, the catch swallowed
 * it, nothing was ever verified, and the delete ran anyway - permanently, for
 * every folder but INBOX. Four defects on one path, all of them invisible from
 * the unit suite, which mocks the vault that was the whole question.
 *
 * So this spec asks the only question that matters end to end, with the real
 * Rust vault and the real mock IMAP server on both ends of it. Two messages,
 * same account, same folder, same rule, one difference:
 *
 *   VICTIM - archived into the vault first. The rule may take it.
 *   ORPHAN - never archived. The rule may not touch it.
 *
 * and three places the outcome has to agree:
 *
 *   the report   "1 deleted, 0 archived, 1 skipped (no verified copy)"
 *   the server   VICTIM moved to Trash (not expunged), ORPHAN still in INBOX
 *   the vault    VICTIM's copy still on disk, stamped serverDeleted
 *
 * The server check is what makes the report mean something: a run that counted
 * one delete and issued two would pass a report-only assertion. The report is
 * what makes the server check mean something: a run that deleted nothing at all
 * also leaves the ORPHAN in INBOX. And the vault check is the last of the four
 * defects - the uids the engine takes are stamped serverDeleted, which is what
 * turns "saved in your vault" into "your only copy".
 *
 * ── Why the stamp and not the glyph ───────────────────────────────────────
 * The stamp is asserted where the engine writes it (local-index.json) rather
 * than on the row's `data-state`, and that is not a softer question - it is a
 * question about this rule instead of about two subsystems downstream of it.
 * Measured on this runner, within ~20s of the run: the delta sync prunes the
 * deleted uid's header sidecar (loadEmails.js, `prunedUids` - correct, the
 * message really did leave INBOX), and `repair_generation` then moves the
 * vault .eml into `orphaned/` and drops its index entry, because a vault file
 * whose Message-ID no sidecar carries is exactly what a uid reissue looks like.
 * `locally_created_uids` protects `local_sent` / `local_draft` from that and
 * knows nothing about serverDeleted. Until it does, the glyph is not a stable
 * question to ask, and asking it here would report that defect as this one.
 *
 * ── Why yoda ──────────────────────────────────────────────────────────────
 * MOCK_ACCOUNTS (wdio.conf.js): yoda's INBOX count is asserted nowhere, and it
 * is the account other specs already mutate and restore. Its MOVE and EXPUNGE
 * stall 4s by design, so every wait here is sized for a delete that takes
 * seconds. Nothing built into the fixtures is old enough to match a 24-month
 * rule - mockImap's `stamp()` dates every message 2026-01-01 plus uid days, so
 * the fixture mail is in the future, not the past. Both messages here are
 * APPENDed with a 2020 date, which is what makes them the only stale mail in
 * the mailbox and the rule's blast radius exactly these two.
 *
 * ── What this leaves behind ───────────────────────────────────────────────
 * Nothing. `after` permanently deletes both messages wherever they ended up,
 * INBOX and Trash, because one mock server serves the whole run and a message
 * this spec strands is a message every later spec file is missing. It also
 * removes the rule and drops premium again, so a later spec does not inherit
 * an armed cleanup rule.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, closeSettings } from './helpers.js';
import { openTab, setPremium } from './mockBilling.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda

const VICTIM = 'Cleanup rule keeps a verified copy';
const ORPHAN = 'Cleanup rule leaves an unproven copy';
const VICTIM_ID = '<cleanup-rule-victim@mock.test>';
const ORPHAN_ID = '<cleanup-rule-orphan@mock.test>';

// Older than any threshold the picker can build, and far outside the fixture
// range, so the rule below matches these two messages and nothing else.
const OLD_HEADER_DATE = 'Wed, 01 Jan 2020 12:00:00 +0000';
const OLD_INTERNAL_DATE = new Date('2020-01-01T12:00:00Z');

const rfc822 = (subject, messageId) => Buffer.from([
  'From: Archivist <archivist@mock.test>',
  `To: ${YODA}`,
  `Subject: ${subject}`,
  `Date: ${OLD_HEADER_DATE}`,
  `Message-ID: ${messageId}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${subject} - body`,
  '',
].join('\r\n'));

describe('An auto-cleanup rule deletes only what the vault can prove', function () {
  this.timeout(300_000);

  let yodaId;
  let victimUid;
  let orphanUid;
  let ruleId;

  // ── The server, behind the app's back ──────────────────────────────────

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({
      host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  /** UIDs of `subject` in `mailbox`, straight from the server. */
  const uidsIn = (mailbox, subject) => withYoda(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject }, { uid: true });
    } finally {
      lock.release();
    }
  });

  // ── The app ────────────────────────────────────────────────────────────

  const activate = (id) => browser.execute((accountId) => {
    window.__MAIL_STORE__.getState().activateAccount(accountId, 'INBOX');
  }, id);

  const listedSubjects = () => browser.execute(() =>
    (window.__MAIL_STORE__.getState().sortedEmails || []).map((e) => e.subject || ''));

  const invokeApp = (command, args) => browser.executeAsync(async (cmd, a, done) => {
    try {
      done({ value: await window.__TAURI_INTERNALS__.invoke(cmd, a) });
    } catch (e) {
      done({ error: String(e) });
    }
  }, command, args);

  /** What the vault holds for a uid, or `{ error }` when the read fails. */
  const vaultCopy = (uid) => invokeApp('maildir_read_light', {
    accountId: yodaId, mailbox: 'INBOX', uid,
  });

  const settingsText = () => browser.execute(() =>
    document.querySelector('[data-testid="settings-page"]')?.innerText || '');

  async function clickButton(label) {
    await browser.waitUntil(() => browser.execute((needle) =>
      [...document.querySelectorAll('button')]
        .some((el) => el.offsetHeight > 0 && el.textContent.trim() === needle), label),
    { timeout: 15_000, interval: 300, timeoutMsg: `Storage settings never offered a "${label}" button` });
    await browser.execute((needle) => {
      [...document.querySelectorAll('button')]
        .find((el) => el.offsetHeight > 0 && el.textContent.trim() === needle).click();
    }, label);
  }

  // ── Setup: two stale messages, one of them in the vault, one armed rule ──

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await setPremium(true);

    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();

    // 1. Two messages the rule will find stale, straight onto the server.
    const appended = await withYoda(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const victim = await client.append(
          'INBOX', rfc822(VICTIM, VICTIM_ID), [], OLD_INTERNAL_DATE);
        const orphan = await client.append(
          'INBOX', rfc822(ORPHAN, ORPHAN_ID), [], OLD_INTERNAL_DATE);
        return { victim: victim?.uid, orphan: orphan?.uid };
      } finally {
        lock.release();
      }
    });
    // APPENDUID is the mock's own answer (it advertises UIDPLUS), but a uid this
    // whole spec keys on is worth proving against a SEARCH rather than trusting
    // one response line.
    victimUid = appended.victim ?? (await uidsIn('INBOX', VICTIM))[0];
    orphanUid = appended.orphan ?? (await uidsIn('INBOX', ORPHAN))[0];
    expect(victimUid).toBeGreaterThan(0);
    expect(orphanUid).toBeGreaterThan(0);
    expect(orphanUid).not.toBe(victimUid);

    // 2. Make the app see them. The engine reads the header cache, not the
    // store, so this is also what puts them where the rule can find them.
    await activate(yodaId);
    await browser.waitUntil(async () => {
      const subjects = await listedSubjects();
      return subjects.includes(VICTIM) && subjects.includes(ORPHAN);
    }, {
      timeout: 120_000,
      interval: 1000,
      timeoutMsg: `yoda's INBOX never listed the two appended messages (uids ${victimUid}, ${orphanUid})`,
    });

    // 3. Put the VICTIM in the vault, and only the VICTIM. This is the exact
    // invoke the engine's archive-then-delete arm was getting wrong.
    const archived = await browser.executeAsync(async (accountId, uids, done) => {
      const account = window.__MAIL_STORE__.getState().accounts.find((a) => a.id === accountId);
      try {
        await window.__TAURI_INTERNALS__.invoke('archive_emails', {
          accountId, accountJson: JSON.stringify(account), mailbox: 'INBOX', uids,
        });
        done({ ok: true });
      } catch (e) {
        done({ error: String(e) });
      }
    }, yodaId, [victimUid]);
    expect(archived.error).toBeUndefined();

    // The vault's own answer, not the archiver's exit code: "it returned" and
    // "there is a file holding this message" are different claims, and the
    // second one is what the engine is about to ask for.
    await browser.waitUntil(async () => (await vaultCopy(victimUid))?.value?.subject === VICTIM, {
      timeout: 60_000,
      interval: 1000,
      timeoutMsg: `the vault never held "${VICTIM}" after archive_emails (uid ${victimUid})`,
    });
    const orphanInVault = await vaultCopy(orphanUid);
    expect(orphanInVault?.value?.subject).not.toBe(ORPHAN);

    // 4. The rule itself, in the one shape the add form writes.
    ruleId = await browser.execute((account) => {
      const store = window.__SETTINGS_STORE__.getState();
      store.addCleanupRule({
        account, folder: 'INBOX', age: 24, unit: 'months', action: 'delete', enabled: true,
      });
      const rules = window.__SETTINGS_STORE__.getState().cleanupRules;
      return rules[rules.length - 1]?.id || null;
    }, YODA);
    expect(ruleId).toBeTruthy();
    const rule = await browser.execute((id) =>
      window.__SETTINGS_STORE__.getState().cleanupRules.find((r) => r.id === id), ruleId);
    expect(rule.enabled).toBe(true);
    expect(rule.folder).toBe('INBOX');
    expect(rule.account).toBe(YODA);
  });

  afterEach(async function () {
    if (this.currentTest.state !== 'failed') return;
    console.log('Cleanup rule diagnostics', JSON.stringify(await browser.execute((victim, orphan, uid) => {
      const stateOf = (needle) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find((r) => (r.textContent || '').includes(needle));
        if (!row) return null;
        return row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') ?? 'no-icon';
      };
      const s = window.__MAIL_STORE__.getState();
      const pick = (e) => (e ? {
        source: e.source, isArchived: e.isArchived, isLocal: e.isLocal,
        serverDeleted: e.serverDeleted, _origin: e._origin,
      } : null);
      return {
        settings: document.querySelector('[data-testid="settings-page"]')?.innerText,
        lastRun: window.__SETTINGS_STORE__.getState().cleanupLastRun,
        rules: window.__SETTINGS_STORE__.getState().cleanupRules,
        rowStates: { victim: stateOf(victim), orphan: stateOf(orphan) },
        victimUid: uid,
        serverUidsComplete: s.serverUids?.complete,
        archivedHasVictim: s.archivedEmailIds?.has(uid),
        inEmails: pick((s.emails || []).find((e) => e.uid === uid)),
        inLocalEmails: pick((s.localEmails || []).find((e) => e.uid === uid)),
        inSorted: pick((s.sortedEmails || []).find((e) => e.uid === uid)),
      };
    }, VICTIM, ORPHAN, victimUid), null, 2));
  });

  after(async function () {
    await closeSettings().catch(() => {});
    if (ruleId) {
      await browser.execute((id) => window.__SETTINGS_STORE__.getState().removeCleanupRule(id), ruleId);
    }
    await setPremium(false).catch(() => {});

    // Both messages, wherever they ended up. Flag and expunge, not a move: this
    // is the one place in the run that is allowed to destroy them, and leaving
    // either in Trash hands the next spec file a mailbox it did not expect.
    for (const mailbox of ['INBOX', 'Trash']) {
      for (const subject of [VICTIM, ORPHAN]) {
        try {
          const uids = await uidsIn(mailbox, subject);
          if (!uids.length) continue;
          await withYoda(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
              await client.messageDelete(uids, { uid: true });
            } finally {
              lock.release();
            }
          });
        } catch (e) {
          console.warn(`[cleanup-rules] could not purge "${subject}" from ${mailbox}:`, e.message);
        }
      }
    }
  });

  it('deletes the verified copy to Trash, skips the unproven one, and stamps the vault', async function () {
    // ── The run ──────────────────────────────────────────────────────────
    await openTab('Storage');
    await clickButton('Run All Now');

    // The report line is also the wait: it renders from the stored run, so its
    // arrival is what says the engine finished.
    //
    // The vault and the stamp are read in the SAME poll that finds the line,
    // not in a step after it. `repair_generation` moves a vault file aside once
    // no sidecar carries its Message-ID, and the delta sync prunes the deleted
    // uid's sidecar seconds later - so a read one round trip further on is
    // racing a subsystem that has nothing to do with this rule. See the header.
    let outcome = null;
    await browser.waitUntil(async () => {
      const reported = /1 deleted, 0 archived, 1 skipped/.test(await settingsText());
      if (!reported) return false;
      outcome = await browser.executeAsync(async (accountId, uid, done) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const out = {};
        try {
          out.vault = await invoke('maildir_read_light', { accountId, mailbox: 'INBOX', uid });
        } catch (e) { out.vaultError = String(e); }
        try {
          const raw = await invoke('local_index_read', { accountId, mailbox: 'INBOX' });
          out.entry = (JSON.parse(raw || '[]') || []).find((e) => e.uid === uid) || null;
        } catch (e) { out.indexError = String(e); }
        done(out);
      }, yodaId, victimUid);
      return true;
    }, {
      timeout: 180_000,
      interval: 1000,
      timeoutMsg: 'The last-run line never reported 1 deleted, 0 archived, 1 skipped '
        + '(see the diagnostics dump below for what Settings said instead)',
    });

    // ── The vault ────────────────────────────────────────────────────────
    // The copy the delete was allowed on account of is still here. A delete
    // that also lost the vault file would satisfy every server assertion below.
    expect(outcome.vault?.subject).toBe(VICTIM);

    // And it is stamped: "this app deleted the server copy" is the durable
    // proof that turns the vault row from "saved in your vault" into "your only
    // copy" (stores/slices/custody.js). Asserted on the engine's own write
    // rather than on the glyph, because the glyph is one subsystem further on -
    // again, see the header.
    expect(outcome.entry).toBeTruthy();
    expect(outcome.entry.serverDeleted).toBe(true);

    // ── The server ───────────────────────────────────────────────────────
    // The verified copy left INBOX, and it is in Trash rather than gone: a rule
    // on any folder but the Trash role moves, so a user who misjudged the rule
    // still has the message.
    await browser.waitUntil(async () => (await uidsIn('INBOX', VICTIM)).length === 0, {
      timeout: 120_000,
      interval: 1000,
      timeoutMsg: `"${VICTIM}" was reported deleted but is still in yoda's INBOX`,
    });
    expect(await uidsIn('Trash', VICTIM)).toHaveLength(1);

    // And the unproven one was not touched, in either direction. This is the
    // whole bug in one assertion: before b29414c9 the archive invoke was
    // rejected, nothing was verified, and both of these went.
    expect(await uidsIn('INBOX', ORPHAN)).toHaveLength(1);
    expect(await uidsIn('Trash', ORPHAN)).toEqual([]);

    // Nor did the rule put the unproven one in the vault on its way past: the
    // action is `delete`, and a skip means skipped, not archived quietly.
    const orphanInVault = await vaultCopy(orphanUid);
    expect(orphanInVault?.value?.subject).not.toBe(ORPHAN);
  });
});
