/**
 * E2E: one reply leaves ONE copy in Sent, and that copy is the message that
 * went out.
 *
 * The report: replied once, and the conversation then showed two "Re: …" rows
 * at the same minute, one with the server cloud and one amber "Only copy".
 * Compose stages a local copy under the Message-ID `smtp_build_mime` gave it,
 * then handed the send to `smtp_send_email`, which built the MIME again with a
 * NEW Message-ID. Every place a local copy meets the server's is keyed on the
 * Message-ID, so the two never matched: the only thing that removed the local
 * copy was the `send-server-append-complete` listener, and only on `ok`. A
 * slow server broke it twice over: the daemon gives up on an APPEND after
 * 20 s and reported a failure even when the server kept the message, and the
 * listener was gone after 30 s anyway. Both copies stayed.
 *
 * Two cases, both through the real compose window and the mock SMTP server:
 *  - a fast APPEND: the local copy, the bytes SMTP was handed and the server's
 *    Sent copy all carry one Message-ID;
 *  - a slow APPEND (luke's `SLOW_APPEND_MARKER` fault, see wdio.conf.js): the
 *    daemon times out at 20 s, the mock stores the message at 40 s, and the
 *    daemon's re-check finds it there. After the next Sent refresh the
 *    conversation and the Sent folder hold one copy, not an "Only copy" too.
 *    This leans on the timed-out session's LOGOUT blocking until the mock
 *    wakes (so the re-check runs after the store): if that ever returns
 *    early, this case goes red with no product regression.
 *
 * The SMTP side is read from the daemon's own log (`[send:raw_headers]` and
 * the `[send:messageid_header]` line after it): the spec cannot reach what the
 * mock SMTP listener recorded. The Rust tests pin that half against the mock
 * directly (src-daemon handlers/smtp.rs).
 *
 * `after` puts luke's Sent folder back (`trackMailbox`): one mock server
 * serves the whole run. `expect(value, 'message')` throws in this runner.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir, trackMailbox, MOCK_PASSWORD, SLOW_APPEND_MARKER } from './mockImap.js';
import { modalOpen, fieldValue, setField, closeComposeHard, settingsCall } from './composeHelpers.js';

const LUKE = 'luke@mock.test';
const FAST_MARKER = 'sent-once-check';

const bare = (id) => (id || '').trim().replace(/^</, '').replace(/>$/, '');

/** `browser.waitUntil` whose failure names what never happened AND the last value seen. */
async function waitFor(probe, ok, what, timeout = 45_000, interval = 500) {
  let last = null;
  try {
    await browser.waitUntil(async () => { last = await probe(); return ok(last); }, { timeout, interval, timeoutMsg: what });
  } catch (err) {
    throw new Error(`${what} — last seen: ${JSON.stringify(last)} (${err.message})`);
  }
  return last;
}

/** What luke's Sent folder holds on the SERVER for `marker`: uid + Message-ID. */
async function serverSentCopies(marker) {
  const { host, port } = browser.mockImap[0];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: 'e2e-harness', pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  const out = [];
  try {
    await client.mailboxOpen('Sent');
    for await (const msg of client.fetch('1:*', { uid: true, envelope: true })) {
      if ((msg.envelope?.subject || '').includes(marker)) out.push({ uid: msg.uid, messageId: msg.envelope.messageId || null });
    }
  } finally {
    await client.logout();
  }
  return out;
}

/** Most recently written `daemon.log*`. */
function daemonLog() {
  const dir = join(appDataDir(browser.testDataDir), 'logs');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).filter((n) => n.startsWith('daemon.log'));
  if (!files.length) return '';
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return readFileSync(join(dir, files[0]), 'utf8');
}

/**
 * The Message-ID of the bytes the daemon handed to SMTP for the message titled
 * with `marker`: the `[send:messageid_header]` line that follows the
 * `[send:raw_headers]` block carrying that Subject.
 */
function smtpMessageId(marker) {
  const mine = daemonLog().split('[send:raw_headers]').slice(1)
    .filter((block) => block.split('[send:messageid_header]')[0].includes(marker))
    .pop();
  const m = mine && mine.match(/\[send:messageid_header\][^\n]*extracted=Some\("([^"]+)"\)/);
  return m ? m[1] : null;
}

/** A plain INBOX message to answer, not one an earlier case already answered. */
const pickTarget = (skipUids) => browser.execute((skip) => {
  const s = window.__MAIL_STORE__.getState();
  const row = (s.sortedEmails || []).find((e) => /^Luke message \d+$/.test(e.subject || '')
    && e.messageId && !e._optimistic && !skip.includes(e.uid));
  return row ? { uid: row.uid, subject: row.subject, source: row.source || 'server', mailbox: row._mailbox || 'INBOX' } : null;
}, skipUids);

/** Open `target` the way its row does, then reply from the sender's address. */
async function openReply(target) {
  await browser.execute((t) => {
    window.__MAIL_STORE__.getState().selectEmail(t.uid, t.source, t.mailbox);
  }, target);
  await waitFor(
    () => browser.execute(() => {
      const addr = [...document.querySelectorAll('[data-testid="sender-address"]')].find((a) => a.offsetHeight > 0);
      if (!addr) return false;
      addr.click();
      return true;
    }),
    (clicked) => clicked === true,
    `"${target.subject}" opened no sender address to reply from`,
    30_000,
    500,
  );
  await waitFor(
    async () => ({ open: await modalOpen(), to: await fieldValue('compose-to'), subject: await fieldValue('compose-subject') }),
    (s) => s.open && !!s.to && (s.subject || '').startsWith('Re:'),
    'the sender address opened no prefilled reply',
    30_000,
    300,
  );
}

/**
 * Remember the Message-ID of the optimistic row compose inserts for `marker`
 * — the id the local copy was staged under. A store subscription, not a poll:
 * on a fast APPEND the row is gone again within milliseconds.
 */
const watchStagedId = (marker) => browser.execute((m) => {
  window.__stagedIds = window.__stagedIds || {};
  const grab = (s) => {
    for (const e of s.sentEmails || []) {
      if (e._optimistic && (e.subject || '').includes(m) && e.messageId) window.__stagedIds[m] = e.messageId;
    }
  };
  grab(window.__MAIL_STORE__.getState());
  window.__MAIL_STORE__.subscribe(grab);
  return true;
}, marker);

const stagedId = (marker) => browser.execute((m) => (window.__stagedIds || {})[m] || null, marker);

async function clickSend() {
  const sent = await browser.execute(() => {
    const btn = document.querySelector('[data-testid="compose-send"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  expect(sent).toBe(true);
}

/**
 * Every copy of the `marker` reply the INBOX view holds: the Sent list merged
 * into the conversation (`sentEmails`) and the pool threads are built from
 * (`getChatEmails`, INBOX + Sent, deduped by Message-ID).
 */
const inboxCopies = (marker) => browser.execute((m) => {
  const s = window.__MAIL_STORE__.getState();
  const mine = (e) => (e.subject || '').includes(m);
  return {
    sent: (s.sentEmails || []).filter(mine).map((e) => ({ uid: e.uid, optimistic: !!e._optimistic, messageId: e.messageId || null })),
    chat: (s.getChatEmails?.() || []).filter(mine).map((e) => ({ uid: e.uid, optimistic: !!e._optimistic, staged: !!e._localStaged })),
  };
}, marker);

/** The rows the Sent folder list derives for `marker` — server rows and vault rows alike. */
const sentFolderRows = (marker) => browser.execute((m) => {
  const s = window.__MAIL_STORE__.getState();
  return (s.sortedEmails || []).filter((e) => (e.subject || '').includes(m))
    .map((e) => ({ uid: e.uid, source: e.source || null, staged: !!e._localStaged, origin: e._origin || null }));
}, marker);

const refreshSent = () => browser.execute(() => {
  const s = window.__MAIL_STORE__.getState();
  s.loadSentHeaders?.(s.activeAccountId);
  return true;
});

describe('One reply, one Sent copy', function () {
  this.timeout(300_000);

  let restoreSent;
  const answered = [];

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    // Send now: the undo window would only delay what these cases read.
    await settingsCall('setSendDelay', 0);
    restoreSent = await trackMailbox(browser.mockImap[0], 'Sent');
  });

  after(async function () {
    await restoreSent?.();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  async function sendReply(marker) {
    const target = await pickTarget(answered);
    expect(target).not.toBeNull();
    answered.push(target.uid);
    await openReply(target);
    expect(await setField('compose-subject', `Re: ${target.subject} ${marker}`)).toBe(true);
    await watchStagedId(marker);
    await clickSend();
    return target;
  }

  it('sends the message under the Message-ID its local copy was staged with', async function () {
    await sendReply(FAST_MARKER);

    const copies = await waitFor(
      () => serverSentCopies(FAST_MARKER),
      (c) => c.length >= 1,
      'the reply never reached the server\'s Sent folder',
      60_000,
      1000,
    );
    expect(copies).toHaveLength(1);

    const staged = await stagedId(FAST_MARKER);
    expect(staged).toBeTruthy();
    const smtp = await waitFor(async () => smtpMessageId(FAST_MARKER), (id) => !!id, 'daemon.log never named the id it sent', 20_000);
    // One message, one id: the staged local copy, the wire and the server.
    expect(bare(smtp)).toBe(bare(staged));
    expect(bare(copies[0].messageId)).toBe(bare(staged));

    const seen = await waitFor(
      () => inboxCopies(FAST_MARKER),
      (s) => s.sent.length === 1 && !s.sent[0].optimistic,
      'the Sent list never settled on the server\'s copy alone',
      30_000,
    );
    expect(seen.chat).toHaveLength(1);
  });

  it('still holds one copy when the server files the Sent APPEND after the client gave up', async function () {
    await sendReply(SLOW_APPEND_MARKER);
    const staged = await waitFor(() => stagedId(SLOW_APPEND_MARKER), (id) => !!id, 'no local copy was staged for the reply', 20_000);

    // The mock stores this APPEND only after 40 s; the daemon gave up at 20.
    const copies = await waitFor(
      () => serverSentCopies(SLOW_APPEND_MARKER),
      (c) => c.length >= 1,
      'the slow APPEND never landed on the server',
      75_000,
      1000,
    );
    expect(copies).toHaveLength(1);
    expect(bare(copies[0].messageId)).toBe(bare(staged));
    // Time for the app to hear the APPEND's answer, if it still listens.
    await browser.pause(5000);

    // The next Sent refresh a folder switch or sync would run.
    await refreshSent();
    await waitFor(
      () => inboxCopies(SLOW_APPEND_MARKER),
      (s) => s.sent.some((e) => !e.optimistic),
      'the server\'s copy never reached the Sent list',
      30_000,
    );
    await browser.pause(1000);
    const seen = await inboxCopies(SLOW_APPEND_MARKER);
    // The conversation: one copy, not the staged one beside the server's.
    expect(seen.sent).toHaveLength(1);
    expect(seen.chat).toHaveLength(1);
    expect(seen.chat[0].staged).toBe(false);

    // The Sent folder merges vault rows by uid, so a staged copy the cleanup
    // missed stays there as a second, "Only copy" row.
    await switchToFolder(LUKE, 'Sent');
    await waitFor(() => sentFolderRows(SLOW_APPEND_MARKER), (rows) => rows.length >= 1, 'the reply is not in the Sent folder', 30_000);
    await browser.pause(2000);
    const rows = await sentFolderRows(SLOW_APPEND_MARKER);
    expect(rows).toHaveLength(1);
    expect(rows[0].staged).toBe(false);
    expect(rows[0].source).not.toBe('local-only');
    await switchToFolder(LUKE, 'INBOX');
  });
});
