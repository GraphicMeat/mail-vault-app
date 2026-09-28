/**
 * E2E: Notes to Self, star / done / delete on a note from an account whose
 * folders this session never opened, the account filter, and the reader.
 *
 * The report: star, mark as done and delete did nothing. A card's server
 * actions are aimed at the folder its copy sits in, and the board only
 * trusted folder lists the app had loaded THIS session (the in-memory restore
 * cache). A second account's notes therefore came with star and delete
 * disabled, and nothing on screen said so.
 *
 * Fixtures, all through the real server and the daemon, nothing injected:
 *  - vader (never opened): three notes, each in INBOX and Sent under one
 *    Message-ID, the way a note to self lands. V1 is starred, V2 marked done,
 *    V3 deleted.
 *  - luke (the account on screen): L1 for the account filter and the reader,
 *    L2 for a star followed by Done on the same card.
 *  The notes reach the vault through `archive_emails` and the search index
 *    through the vault's own change hook, which is where the board lists
 *    from. vader's folder list is saved the way the app's background prefetch
 *    saves it (`save_mailbox_cache`), so it is on disk but never in this
 *    session's memory: exactly a second account after a restart.
 *
 * `after` puts every touched server folder back (`trackMailbox`): one mock
 * server serves the whole run. Node's assert, not wdio's expect.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, reloadApp } from './helpers.js';
import { appDataDir, trackMailbox, MOCK_PASSWORD } from './mockImap.js';
import { clickReachable, nativeDaemonInvoke, dismissOnboardingNotice } from './insightsHelpers.js';

const LUKE = 0, VADER = 1;
const NOTE = {
  V1: { who: VADER, subject: 'Notes e2e vader star', id: 'notes-e2e-v1@mock.test', boxes: ['INBOX', 'Sent'] },
  V2: { who: VADER, subject: 'Notes e2e vader done', id: 'notes-e2e-v2@mock.test', boxes: ['INBOX', 'Sent'] },
  V3: { who: VADER, subject: 'Notes e2e vader delete', id: 'notes-e2e-v3@mock.test', boxes: ['INBOX', 'Sent'] },
  L1: { who: LUKE, subject: 'Notes e2e luke reader', id: 'notes-e2e-l1@mock.test', boxes: ['INBOX'] },
  L2: { who: LUKE, subject: 'Notes e2e luke star then done', id: 'notes-e2e-l2@mock.test', boxes: ['INBOX'] },
};

const account = (who) => browser.mockAccounts[who];

async function withServer(who, fn) {
  const { host, port } = browser.mockImap[who];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: account(who).email, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try { return await fn(client); } finally { await client.logout(); }
}

const rfc822 = ({ who, subject, id }) => Buffer.from([
  `From: ${account(who).email}`,
  `To: ${account(who).email}`,
  `Subject: ${subject}`,
  'Date: Sun, 20 Sep 2026 09:00:00 +0000',
  `Message-ID: <${id}>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `Body of ${subject}.`,
  '',
].join('\r\n'));

/** Server uids of `subject` in `mailbox`. */
const serverUids = (who, mailbox, subject) => withServer(who, async (client) => {
  const lock = await client.getMailboxLock(mailbox);
  try { return await client.search({ subject }, { uid: true }); } finally { lock.release(); }
});

const cardSel = (subject) => `[data-testid="note-card"][aria-label="${subject}"]`;
const cardState = (subject) => browser.execute((sel) => {
  const card = document.querySelector(sel);
  if (!card) return null;
  const star = card.querySelector('[data-testid="note-star"]');
  return {
    starred: card.dataset.starred === 'true',
    busy: card.getAttribute('aria-busy') === 'true',
    starPressed: star?.getAttribute('aria-pressed'),
    starFilled: !!star?.querySelector('svg')?.getAttribute('class')?.includes('fill-current'),
    starDisabled: !!star?.disabled,
    doneDisabled: !!card.querySelector('[data-testid="note-done"]')?.disabled,
    deleteDisabled: !!card.querySelector('[data-testid="note-delete"]')?.disabled,
  };
}, cardSel(subject));

/** console.warn/error inside the page, so a failed action names itself. */
const installConsoleProbe = () => browser.execute(() => {
  if (window.__notesE2eLog) return;
  const log = window.__notesE2eLog = [];
  for (const level of ['warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => {
      try {
        log.push(`${level}: ${args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.slice(0, 400));
      } catch { /* an unserialisable argument */ }
      return original.apply(console, args);
    };
  }
});

const daemonLogTail = () => {
  const dir = join(appDataDir(browser.testDataDir), 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((f) => f.startsWith('daemon.log'))
    .map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n')
    .split('\n').filter((line) => /notes\.|tags\.|Flagged|delete/i.test(line)).slice(-25).join('\n');
};

/** What the daemon itself says about a note, done ones included. */
const listed = async (subject) => {
  const accounts = browser.mockAccounts.map((a) => ({ accountId: a.id, address: a.email }));
  const reply = await nativeDaemonInvoke('notes.list', { accounts, includeDone: true });
  const card = (reply?.cards || []).find((c) => c.subject === subject);
  return card ? { done: card.done, starred: card.starred, copies: card.copies } : 'absent';
};

const diagnose = async (subject) => JSON.stringify({
  card: await cardState(subject),
  page: await browser.execute(() => ({
    alert: [...document.querySelectorAll('[data-testid="notes-board"] [role="alert"]')].map((el) => el.textContent),
    status: document.querySelector('[data-testid="notes-board"]')?.dataset.status,
    log: (window.__notesE2eLog || []).slice(-15),
  })),
  daemon: await listed(subject).catch((err) => String(err)),
}, null, 1) + `\n--- daemon.log ---\n${daemonLogTail()}`;

async function waitFor(check, what, subject, timeout = 20_000) {
  try {
    await browser.waitUntil(check, { timeout, interval: 250 });
  } catch {
    throw new Error(`${what}\n${await diagnose(subject)}`);
  }
}

/**
 * `clickReachable`, after waiting out anything drawn over the control (a
 * toast, a closing popover's layer), and naming it in the log: a control
 * covered by something the user cannot see is a control that "does nothing".
 */
async function tap(selector) {
  let last = null;
  await browser.waitUntil(async () => {
    const cover = await browser.execute((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!hit || hit === node || node.contains(hit)) return null;
      const owner = hit.closest('[data-testid], [role]');
      return `${hit.tagName}.${String(hit.className).slice(0, 120)} in ${owner?.getAttribute('data-testid') || owner?.getAttribute('role') || 'nothing'}: `
        + `${(owner || hit).textContent.trim().slice(0, 120)}`;
    }, selector);
    if (cover && cover !== last) console.log(`[notes e2e] ${selector} is covered by ${cover}`);
    last = cover;
    // The harness's own "Restart onboarding" notice lands top right, over
    // the board's Refresh, a minute into the run.
    if (cover?.includes('onboarding-refresh-prompt')) await dismissOnboardingNotice();
    return !cover;
  }, { timeout: 30_000, interval: 250 }).catch(() => {});
  await clickReachable(selector);
}

/** Click one of a card's own buttons; a button that cannot be clicked says why. */
async function press(subject, testId) {
  try {
    await tap(`${cardSel(subject)} [data-testid="${testId}"]`);
  } catch (err) {
    throw new Error(`${err.message}\n${await diagnose(subject)}`);
  }
}

const boardReady = () => browser.waitUntil(() => browser.execute(() =>
  document.querySelector('[data-testid="notes-board"]')?.dataset.status === 'ready'),
{ timeout: 30_000, interval: 200, timeoutMsg: 'The Notes board never finished loading' });

async function openNotes() {
  await waitForApp();
  await dismissOnboardingNotice();
  if (!await browser.execute(() => !!document.querySelector('[data-testid="notes-board"]'))) {
    await tap('[data-testid="open-notes"]');
  }
  await boardReady();
}

async function refresh() {
  await tap('[data-testid="notes-refresh"]');
  await boardReady();
}

const present = (subject) => browser.execute((sel) => !!document.querySelector(sel), cardSel(subject));

/** Refresh until every subject is on the board: the index picks a vault write up on its own schedule. */
async function waitForCards(subjects, timeout = 90_000) {
  const missing = async () => (await Promise.all(subjects.map(async (s) => (await present(s) ? null : s)))).filter(Boolean);
  await browser.waitUntil(async () => {
    if (!(await missing()).length) return true;
    await refresh();
    return !(await missing()).length;
  }, { timeout, interval: 2000 }).catch(async () => {
    throw new Error(`Never listed: ${JSON.stringify(await missing())}`);
  });
}

const chipPressed = () => browser.execute(() => Object.fromEntries(
  [...document.querySelectorAll('[data-testid="notes-accounts"] [data-testid^="notes-account-"]')]
    .filter((el) => el.hasAttribute('aria-pressed'))
    .map((el) => [el.dataset.testid.replace('notes-account-', ''), el.getAttribute('aria-pressed') === 'true']),
));

const rightClick = (selector) => browser.execute((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 4, clientY: rect.y + 4 }));
  return true;
}, selector);

describe('Notes to Self', function () {
  this.timeout(300_000);
  const restores = [];

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await installConsoleProbe();

    for (const [who, box] of [[VADER, 'INBOX'], [VADER, 'Sent'], [VADER, 'Trash'], [LUKE, 'INBOX'], [LUKE, 'Trash']]) {
      restores.push(await trackMailbox(browser.mockImap[who], box));
    }

    // The notes, on the server first, then into the vault the board lists from.
    for (const note of Object.values(NOTE)) {
      note.uids = {};
      for (const box of note.boxes) {
        await withServer(note.who, async (client) => {
          const appended = await client.append(box, rfc822(note), [], new Date('2026-09-20T09:00:00Z'));
          note.uids[box] = appended?.uid ?? (await serverUids(note.who, box, note.subject))[0];
        });
        assert.ok(note.uids[box] > 0, `${note.subject} was appended to ${box}`);
        const result = await nativeDaemonInvoke('archive_emails', {
          accountId: account(note.who).id, accountJson: JSON.stringify(account(note.who)), mailbox: box, uids: [note.uids[box]],
        });
        assert.equal(result?.errors || 0, 0, `archive_emails ${note.subject} ${box}: ${JSON.stringify(result)}`);
      }
    }

    // vader's folders as a past session left them: on disk, not in memory.
    const vader = account(VADER);
    const { mailboxes } = await nativeDaemonInvoke('imap_get_mailboxes', { account: vader });
    assert.ok(mailboxes?.some((box) => (box.path || box.name) === 'Sent'), 'vader lists a Sent folder');
    await nativeDaemonInvoke('save_mailbox_cache', { accountId: vader.id, data: JSON.stringify({ mailboxes, fetchedAt: Date.now() }) });
  });

  after(async function () {
    for (const restore of restores) await restore().catch((err) => console.warn('[notes e2e] restore:', err.message));
  });

  it('lists a note from an account whose folders this session never opened', async () => {
    await openNotes();
    await waitForCards(Object.values(NOTE).map((note) => note.subject));
  });

  it('stars that note: the star fills in', async () => {
    await press(NOTE.V1.subject, 'note-star');
    await waitFor(async () => (await cardState(NOTE.V1.subject))?.starFilled === true,
      'V1 star never filled in', NOTE.V1.subject);
    const state = await cardState(NOTE.V1.subject);
    assert.equal(state.starPressed, 'true');
    await waitFor(async () => (await serverUids(VADER, 'INBOX', NOTE.V1.subject)).length === 1
      && await withServer(VADER, async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const msg = await client.fetchOne(String(NOTE.V1.uids.INBOX), { flags: true }, { uid: true });
          return !!msg?.flags?.has('\\Flagged');
        } finally { lock.release(); }
      }), 'The server copy of V1 never got \\Flagged', NOTE.V1.subject);
  });

  it('marks a note done: it leaves the board, and Refresh does not bring it back', async () => {
    await press(NOTE.V2.subject, 'note-done');
    await waitFor(async () => !await present(NOTE.V2.subject), 'V2 stayed on the board after Done', NOTE.V2.subject);
    assert.equal((await listed(NOTE.V2.subject)).done, true, 'the daemon holds V2 as done');
    await refresh();
    assert.equal(await present(NOTE.V1.subject), true, 'the refreshed board lists the other notes');
    assert.equal(await present(NOTE.V2.subject), false, `Refresh brought V2 back\n${await diagnose(NOTE.V2.subject)}`);
  });

  it('takes Done straight after a star on the same card', async () => {
    const started = Date.now();
    await press(NOTE.L2.subject, 'note-star');
    // The card holds its buttons while the star is written; how long is part of the answer.
    await waitFor(async () => !(await cardState(NOTE.L2.subject))?.busy, 'L2 stayed busy after its star', NOTE.L2.subject, 30_000);
    console.log(`[notes e2e] L2 star held the card for ${Date.now() - started} ms`);
    await press(NOTE.L2.subject, 'note-done');
    await waitFor(async () => !await present(NOTE.L2.subject), 'L2 stayed on the board after Done', NOTE.L2.subject);
  });

  it('deletes a note: the card leaves and the server copies go', async () => {
    await press(NOTE.V3.subject, 'note-delete');
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[role="alertdialog"]')),
      { timeout: 10_000, interval: 200, timeoutMsg: 'The delete confirm never opened' });
    const confirmed = await browser.execute(() => {
      const button = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.className.includes('danger'));
      button?.click();
      return !!button;
    });
    assert.equal(confirmed, true, 'The confirm dialog has a delete button');
    await waitFor(async () => !await present(NOTE.V3.subject), 'V3 stayed on the board after Delete', NOTE.V3.subject);
    for (const box of NOTE.V3.boxes) {
      await waitFor(async () => (await serverUids(VADER, box, NOTE.V3.subject)).length === 0,
        `V3 is still in vader's ${box} on the server`, NOTE.V3.subject, 30_000);
    }
  });

  describe('after a reload', () => {
    before(async () => {
      await reloadApp();
      await installConsoleProbe();
      await openNotes();
      await waitForCards([NOTE.L1.subject]);
    });

    it('keeps the done note off the board', async () => {
      assert.equal(await present(NOTE.V2.subject), false, `V2 came back after a reload\n${await diagnose(NOTE.V2.subject)}`);
      assert.equal(await present(NOTE.L2.subject), false, `L2 came back after a reload\n${await diagnose(NOTE.L2.subject)}`);
    });

    it('keeps the star', async () => {
      await browser.waitUntil(async () => {
        if ((await cardState(NOTE.V1.subject))?.starred) return true;
        await refresh();
        return !!(await cardState(NOTE.V1.subject))?.starred;
      }, { timeout: 60_000, interval: 2000 }).catch(async () => {
        throw new Error(`V1 is not starred after a reload\n${await diagnose(NOTE.V1.subject)}`);
      });
      assert.equal((await cardState(NOTE.V1.subject)).starFilled, true);
    });
  });

  describe('account filter', () => {
    const vaderId = () => account(VADER).id;
    const lukeId = () => account(LUKE).id;

    it('turns every account off and on again with Deselect all and Select all', async () => {
      await tap('[data-testid="notes-deselect-all"]');
      let pressed = await chipPressed();
      assert.ok(Object.keys(pressed).length >= 2, `the bar lists the accounts: ${JSON.stringify(pressed)}`);
      assert.ok(Object.values(pressed).every((on) => !on), `Deselect all left one on: ${JSON.stringify(pressed)}`);
      assert.equal(await browser.execute(() => document.querySelectorAll('[data-testid="note-card"]').length), 0);
      assert.equal(await browser.execute(() => document.querySelector('[data-testid="notes-deselect-all"]').disabled), true);

      await tap('[data-testid="notes-select-all"]');
      pressed = await chipPressed();
      assert.ok(Object.values(pressed).every(Boolean), `Select all left one off: ${JSON.stringify(pressed)}`);
      assert.equal(await browser.execute(() => document.querySelector('[data-testid="notes-select-all"]').disabled), true);
      assert.equal(await present(NOTE.L1.subject), true);
    });

    it('keeps only the right-clicked account with "Deselect all except this one"', async () => {
      assert.equal(await rightClick(`[data-testid="notes-account-${vaderId()}"]`), true);
      await tap('[data-testid="notes-menu-deselect-all-except"]');
      const pressed = await chipPressed();
      assert.equal(pressed[vaderId()], true, JSON.stringify(pressed));
      assert.ok(Object.entries(pressed).every(([id, on]) => id === vaderId() || !on), JSON.stringify(pressed));
      assert.equal(await present(NOTE.V1.subject), true, 'vader\'s note shows');
      assert.equal(await present(NOTE.L1.subject), false, 'luke\'s note is hidden');
    });

    it('turns only the right-clicked account off with "Select all except this one"', async () => {
      assert.equal(await rightClick(`[data-testid="notes-account-${vaderId()}"]`), true);
      await tap('[data-testid="notes-menu-select-all-except"]');
      const pressed = await chipPressed();
      assert.equal(pressed[vaderId()], false, JSON.stringify(pressed));
      assert.equal(pressed[lukeId()], true, JSON.stringify(pressed));
      assert.ok(Object.entries(pressed).every(([id, on]) => id === vaderId() || on), JSON.stringify(pressed));
      assert.equal(await present(NOTE.V1.subject), false, 'vader\'s note is hidden');
      assert.equal(await present(NOTE.L1.subject), true, 'luke\'s note shows');

      assert.equal(await rightClick(`[data-testid="notes-account-${lukeId()}"]`), true);
      await tap('[data-testid="notes-menu-select-all"]');
      assert.ok(Object.values(await chipPressed()).every(Boolean), 'the menu\'s Select all turns every account on');
    });
  });

  describe('the reader', () => {
    const readerStar = '[data-testid="notes-reader"] [data-testid="notes-reader-star"]';
    const starState = () => browser.execute((sel) => {
      const star = document.querySelector(sel);
      return star && { pressed: star.getAttribute('aria-pressed'), filled: !!star.querySelector('svg')?.getAttribute('class')?.includes('fill-current') };
    }, readerStar);

    it('opens a note with one close control and an open in new window control', async () => {
      await tap(cardSel(NOTE.L1.subject));
      await browser.waitUntil(() => browser.execute(() =>
        document.querySelector('[data-testid="notes-reader"]')?.textContent.includes('Body of Notes e2e luke reader')),
      { timeout: 30_000, interval: 200, timeoutMsg: 'The reader never showed L1' });
      const controls = await browser.execute(() => {
        const reader = document.querySelector('[data-testid="notes-reader"]');
        const closes = [...reader.querySelectorAll('button')]
          .filter((b) => /^close$/i.test((b.getAttribute('aria-label') || b.title || b.textContent || '').trim()));
        return {
          closeViewer: reader.querySelectorAll('[data-testid="close-viewer"]').length,
          headerClose: document.querySelectorAll('[data-testid="notes-close-reader"]').length,
          closes: closes.length,
          openInWindow: !!reader.querySelector('[data-testid="open-in-window"]:not([disabled])'),
        };
      });
      assert.deepEqual(controls, { closeViewer: 1, headerClose: 0, closes: 1, openInWindow: true });
    });

    it('stars and unstars from the reader, the icon following', async () => {
      assert.deepEqual(await starState(), { pressed: 'false', filled: false });
      await tap(readerStar);
      await browser.waitUntil(async () => (await starState())?.filled === true, { timeout: 15_000, timeoutMsg: 'the reader star never filled' });
      assert.equal((await starState()).pressed, 'true');
      assert.equal((await cardState(NOTE.L1.subject)).starFilled, true, 'the card follows the reader');
      await tap(readerStar);
      await browser.waitUntil(async () => (await starState())?.filled === false, { timeout: 15_000, timeoutMsg: 'the reader star never emptied' });
      assert.equal((await starState()).pressed, 'false');
    });

    it('closes with its one close control', async () => {
      await tap('[data-testid="notes-reader"] [data-testid="close-viewer"]');
      await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="notes-reader"]')),
        { timeout: 5_000, timeoutMsg: 'The reader stayed open' });
    });

    it('marks the open note done from the reader, which then closes', async () => {
      await tap(cardSel(NOTE.V1.subject));
      await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="notes-reader-done"]')),
        { timeout: 30_000, interval: 200, timeoutMsg: 'The reader never opened V1' });
      await tap('[data-testid="notes-reader-done"]');
      await waitFor(async () => !await present(NOTE.V1.subject)
        && !await browser.execute(() => !!document.querySelector('[data-testid="notes-reader"]')),
      'V1 or its reader stayed after Done from the reader', NOTE.V1.subject);
    });
  });
});
