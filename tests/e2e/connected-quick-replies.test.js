/**
 * E2E: Quick Reply chips (src/utils/quickReplies.js,
 * src/components/email/QuickReplyChips.jsx) — deterministic Tier 1 starters
 * under the open message, suppressed on automated mail by header signals, a
 * click opens Compose prefilled, nothing ever sends.
 *
 * AI is off by default (`DEFAULT_AI_SETTINGS.enabled === false`,
 * settingsStore.js), so `tier2Starters` short-circuits before it ever asks a
 * provider — every chip here is Tier 1's plain regex heuristic
 * (`tier1Starters`/`threadShape`), which is deterministic and needs no
 * network. That is what makes this spec possible without a model.
 *
 * ── The newsletter fixture ───────────────────────────────────────────────
 * MOCK_ACCOUNTS/scenario() (wdio.conf.js, mockImap.js) has no message
 * carrying List-Unsubscribe/List-Id — the closest thing, mockImap.js's
 * `trackerMessage` (the tracking-pixel newsletter every account's INBOX
 * already carries), was built for the tracker-blocking spec and deliberately
 * has none of those headers either. That fixture config lives in
 * wdio.conf.js/mockImap.js and both are shared by every other connected-*
 * spec, so per this task's own constraint it is not touched here.
 *
 * What does not require touching it: connected-idle-repaint.test.js and
 * connected-cleanup-rules.test.js already establish the pattern this spec
 * reuses — a spec may append its OWN raw message straight over IMAP
 * (`ImapFlow.append`), which reaches the daemon through the exact same sync
 * path as any fixture message and is parsed by the same code
 * (`src-core/src/imap/mod.rs`'s `HEADER_FETCH_SPEC` already requests
 * `List-Unsubscribe`/`List-Id`/`Precedence` for every header sync — nothing
 * app-side is special-cased to fixture content). So this spec appends two
 * messages of its own — one plain, one carrying newsletter headers — and
 * removes them in `after`, the same restraint idle-repaint and cleanup-rules
 * already document.
 *
 * ── Why yoda ─────────────────────────────────────────────────────────────
 * "the account other specs already mutate and restore" (cleanup-rules'
 * comment) — nothing here reads yoda's INBOX count, and both messages are
 * dated 2020 (mockImap's `stamp()` dates fixture mail 2026-onward), which
 * keeps them off the top of every list a different spec might open.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { testidPresent, modalOpen, editorText, closeComposeHard } from './composeHelpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const PLAIN_SUBJECT = 'Quick reply plain thread check';
const PLAIN_MESSAGE_ID = '<quick-reply-plain@mock.test>';
const NEWS_SUBJECT = 'Quick reply newsletter suppression check';
const NEWS_MESSAGE_ID = '<quick-reply-newsletter@mock.test>';

const OLD_HEADER_DATE = 'Wed, 01 Jan 2020 12:00:00 +0000';
const OLD_INTERNAL_DATE = new Date('2020-01-01T12:00:00Z');

const plainRfc822 = () => Buffer.from([
  'From: Partner <partner@quickreply.test>',
  `To: ${YODA}`,
  `Subject: ${PLAIN_SUBJECT}`,
  `Date: ${OLD_HEADER_DATE}`,
  `Message-ID: ${PLAIN_MESSAGE_ID}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Can you send over the updated invoice by Friday?',
  '',
].join('\r\n'));

const newsletterRfc822 = () => Buffer.from([
  'From: Notices <notices@quickreply.test>',
  `To: ${YODA}`,
  `Subject: ${NEWS_SUBJECT}`,
  `Date: ${OLD_HEADER_DATE}`,
  `Message-ID: ${NEWS_MESSAGE_ID}`,
  'List-Unsubscribe: <mailto:unsub@quickreply.test>',
  'List-Id: Quick Reply Notices <notices.quickreply.test>',
  'Precedence: bulk',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  "Check out this week's top stories and offers.",
  '',
].join('\r\n'));

describe('Quick Reply chips', function () {
  this.timeout(180_000);

  let yodaId;

  // ── The server, behind the app's back ────────────────────────────────────

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  const appendToInbox = (raw) => withYoda(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await client.append('INBOX', raw, [], OLD_INTERNAL_DATE);
    } finally {
      lock.release();
    }
  });

  const uidsIn = (mailbox, subject) => withYoda(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject }, { uid: true });
    } finally {
      lock.release();
    }
  });

  const sentUids = () => withYoda(async (client) => {
    const lock = await client.getMailboxLock('Sent');
    try {
      return await client.search({ all: true }, { uid: true });
    } finally {
      lock.release();
    }
  });

  // ── The app ───────────────────────────────────────────────────────────────

  const listedSubjects = () => browser.execute(() =>
    (window.__MAIL_STORE__.getState().sortedEmails || []).map((e) => e.subject || ''));

  const selectedSubject = () => browser.execute(() =>
    window.__MAIL_STORE__.getState().selectedEmail?.subject || null);

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    if (!row) return false;
    row.click();
    return true;
  }, subject);

  async function openMessage(subject) {
    await browser.waitUntil(async () => clickRow(subject), {
      timeout: 60_000, interval: 1000, timeoutMsg: `row "${subject}" never appeared in yoda's INBOX`,
    });
    await browser.waitUntil(async () => (await selectedSubject()) === subject, {
      timeout: 20_000, interval: 300, timeoutMsg: `the viewer never selected "${subject}"`,
    });
  }

  const chipTexts = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="quick-reply-chip"]')].map((b) => b.textContent.trim()));

  async function clickChip(index = 0) {
    const ok = await browser.execute((i) => {
      const btn = document.querySelectorAll('[data-testid="quick-reply-chip"]')[i];
      if (!btn) return false;
      btn.click();
      return true;
    }, index);
    await browser.pause(300);
    return ok;
  }

  async function clickDismiss() {
    const ok = await browser.execute(() => {
      const container = document.querySelector('[data-testid="quick-reply-chips"]');
      const btn = [...(container?.querySelectorAll('button') || [])]
        .find((b) => b.getAttribute('data-testid') !== 'quick-reply-chip');
      if (!btn) return false;
      btn.click();
      return true;
    });
    await browser.pause(300);
    return ok;
  }

  const outboxLength = () => browser.execute(() => (window.__MAIL_STORE__.getState().outboxItems || []).length);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();

    await appendToInbox(plainRfc822());
    await appendToInbox(newsletterRfc822());

    await switchToFolder(YODA, 'INBOX');
    await browser.waitUntil(async () => {
      const subjects = await listedSubjects();
      return subjects.includes(PLAIN_SUBJECT) && subjects.includes(NEWS_SUBJECT);
    }, {
      timeout: 60_000, interval: 1000,
      timeoutMsg: "yoda's INBOX never listed the two appended quick-reply fixture messages",
    });
  });

  after(async function () {
    // This file's own mutations of the shared mock server: the two appended
    // messages, and (best-effort) anything a mis-click sent.
    for (const subject of [PLAIN_SUBJECT, NEWS_SUBJECT]) {
      try {
        const uids = await uidsIn('INBOX', subject);
        if (!uids.length) continue;
        await withYoda(async (client) => {
          const lock = await client.getMailboxLock('INBOX');
          try {
            await client.messageDelete(uids, { uid: true });
          } finally {
            lock.release();
          }
        });
      } catch (e) {
        console.warn(`[quick-replies] could not purge "${subject}" from INBOX:`, e.message);
      }
    }
  });

  it('shows chips under a plain person-to-person message', async function () {
    await openMessage(PLAIN_SUBJECT);
    // Positive control: this message really is plain — no header this spec
    // did not put there, or the "suppressed" case below would pass regardless
    // of whether isAutomatedThread ever looked at it.
    const flags = await browser.execute(() => {
      const e = window.__MAIL_STORE__.getState().selectedEmail;
      return { listUnsubscribe: e?.listUnsubscribe || null, listId: e?.listId || null };
    });
    expect(flags.listUnsubscribe).toBe(null);
    expect(flags.listId).toBe(null);

    await browser.waitUntil(async () => (await chipTexts()).length > 0, {
      timeout: 15_000, interval: 300, timeoutMsg: 'no quick-reply chips rendered for a plain message',
    });
    expect(await testidPresent('quick-reply-chips')).toBe(true);
  });

  it('suppresses chips on a message carrying List-Unsubscribe/List-Id', async function () {
    await openMessage(NEWS_SUBJECT);
    // Positive control: the header sync actually carried the two fields
    // isAutomatedThread reads, so an empty chip list below is the suppression
    // firing and not some unrelated reason starters never rendered.
    await browser.waitUntil(async () => {
      const e = await browser.execute(() => window.__MAIL_STORE__.getState().selectedEmail);
      return !!(e?.listUnsubscribe && e?.listId);
    }, {
      timeout: 20_000, interval: 500,
      timeoutMsg: 'the appended newsletter never carried listUnsubscribe/listId on the synced email object — '
        + 'HEADER_FETCH_SPEC (src-core/src/imap/mod.rs) may not have picked up the fixture headers',
    });

    // A beat for the (would-be) effect to run before asserting the negative.
    await browser.pause(1000);
    expect(await testidPresent('quick-reply-chips')).toBe(false);
  });

  it('opens Compose prefilled from a chip, and sends nothing', async function () {
    await openMessage(PLAIN_SUBJECT);
    await browser.waitUntil(async () => (await chipTexts()).length > 0, {
      timeout: 15_000, interval: 300, timeoutMsg: 'no quick-reply chips rendered for a plain message',
    });
    const starter = (await chipTexts())[0];
    expect(starter).toBeTruthy();

    const sentBefore = await sentUids();

    expect(await clickChip(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000, interval: 300, timeoutMsg: 'clicking a quick-reply chip did not open Compose',
    });
    await browser.waitUntil(async () => ((await editorText()) || '').includes(starter), {
      timeout: 10_000, interval: 300,
      timeoutMsg: `Compose opened but its body never carried the chip's own text ("${starter}")`,
    });

    // Nothing was clicked that could send it — Compose stayed open, the
    // outbox is untouched, and a short wait rules out anything firing on its
    // own before the window is closed unsent.
    expect(await outboxLength()).toBe(0);
    await browser.pause(2000);
    expect(await outboxLength()).toBe(0);
    expect(await sentUids()).toEqual(sentBefore);

    await closeComposeHard();
    expect(await modalOpen()).toBe(false);
  });

  it('keeps chips dismissed for the same thread after reselecting it', async function () {
    await openMessage(PLAIN_SUBJECT);
    await browser.waitUntil(async () => (await chipTexts()).length > 0, {
      timeout: 15_000, interval: 300, timeoutMsg: 'no quick-reply chips rendered for a plain message',
    });

    expect(await clickDismiss()).toBe(true);
    await browser.waitUntil(async () => !(await testidPresent('quick-reply-chips')), {
      timeout: 10_000, interval: 300, timeoutMsg: 'dismissing the chips did not remove them',
    });

    // Select away and back — the same thread, re-opened, not just left alone.
    await openMessage(NEWS_SUBJECT);
    await openMessage(PLAIN_SUBJECT);
    // A beat for the effect to run before asserting the negative.
    await browser.pause(1000);
    expect(await testidPresent('quick-reply-chips')).toBe(false);

    // Positive control: clearing the dismissal on the same, still-open message
    // brings the chips straight back — proving the negative above was the
    // dismissal and not the effect having simply stopped running for this
    // message. `dismissedQuickReplyThreads` is a settingsStore seam, which the
    // harness rules permit writing directly in a connected-* spec.
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ dismissedQuickReplyThreads: {} }));
    await browser.waitUntil(async () => (await chipTexts()).length > 0, {
      timeout: 10_000, interval: 300,
      timeoutMsg: 'clearing dismissedQuickReplyThreads did not bring the chips back — '
        + 'the earlier "hidden" result may not have been the dismissal at all',
    });
  });
});
