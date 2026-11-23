// Captures "Keep in bubble": keeping from the reader, one bubble per sender with its count centred,
// the group panel, the single-bubble hover, reopening from another folder, moving the dock, the narrow
// window, and the toggle in the thread, Notes and Insights readers. Mock account 1 (INBOX seeded over
// IMAP append, dated after the fixture's newest mail so the rows sit at the top of the list). Driven by .harness/capture.sh.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
import { trackMailbox, MOCK_PASSWORD } from './mockImap.js';
import { clickReachable, setControl, waitForInsights, nativeDaemonInvoke, dismissOnboardingNotice, openInsights, setInsightsRange } from './insightsHelpers.js';

const ACCOUNT = 1;
const SAM = { name: 'Sam Rivera', address: 'sam.rivera@mock.test' };
const LENA = { name: 'Lena Ortiz', address: 'lena.ortiz@mock.test' };
const SAM_SUBJECTS = ['Quarterly plan v3', 'Venue shortlist', 'Invoice 2291'];
const LENA_SUBJECT = 'Design review notes';
const THREAD_SUBJECT = 'Offsite agenda';
const NOTE_SUBJECT = 'Capture: keep note';
const out = resolve(process.env.HARNESS_SHOTS_OUT || '.artifacts');
const account = () => browser.mockAccounts[ACCOUNT];
const wait = (predicate, message, timeout = 30_000) => browser.waitUntil(predicate, { timeout, interval: 200, timeoutMsg: message });

async function withServer(fn) {
  const { host, port } = browser.mockImap[ACCOUNT];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: account().email, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try { return await fn(client); } finally { await client.logout(); }
}

function message({ from, subject, id, day, inReplyTo = null, to = account().email }) {
  return Buffer.from([
    `From: ${from.name} <${from.address}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${day} Jan 2028 09:00:00 +0000`,
    `Message-ID: <${id}@mock.test>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}@mock.test>`, `References: <${inReplyTo}@mock.test>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Body of ${subject}.`,
    '',
  ].join('\r\n'));
}

async function append(mailbox, spec) {
  const appended = await withServer(client => client.append(mailbox, message(spec), [], new Date(`${spec.day} Jan 2028 09:00:00 +0000`)));
  assert.ok(appended?.uid > 0, `${spec.subject} appended to ${mailbox}`);
  return appended.uid;
}

async function seed() {
  const day = n => String(n).padStart(2, '0');
  for (const [i, subject] of SAM_SUBJECTS.entries()) await append('INBOX', { from: SAM, subject, id: `keep-sam-${i}`, day: day(10 + i) });
  await append('INBOX', { from: LENA, subject: LENA_SUBJECT, id: 'keep-lena', day: '13' });
  await append('INBOX', { from: LENA, subject: THREAD_SUBJECT, id: 'keep-thread-1', day: '14' });
  await append('INBOX', { from: SAM, subject: `Re: ${THREAD_SUBJECT}`, id: 'keep-thread-2', day: '15', inReplyTo: 'keep-thread-1' });
  const noteUid = await append('INBOX', { from: { name: 'Me', address: account().email }, subject: NOTE_SUBJECT, id: 'keep-note', day: '16' });
  const archived = await nativeDaemonInvoke('archive_emails', {
    accountId: account().id, accountJson: JSON.stringify(account()), mailbox: 'INBOX', uids: [noteUid],
  });
  assert.equal(archived?.errors || 0, 0, `archive_emails: ${JSON.stringify(archived)}`);
}

async function setMode(theme) {
  await browser.execute(value => {
    if (document.documentElement.getAttribute('data-theme') === value) return;
    [...document.querySelectorAll('button')]
      .find(button => /^switch to (light|dark) mode$/i.test((button.getAttribute('aria-label') || button.title || '').trim()))?.click();
  }, theme);
  await wait(() => browser.execute(value => document.documentElement.getAttribute('data-theme') === value, theme), `Theme ${theme} did not apply`, 5000);
}

/** The reader or list row whose text holds `subject`, clicked. */
async function clickRow(subject) {
  try {
    await wait(() => browser.execute(text => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')].find(r => r.innerText.includes(text));
      row?.click();
      return !!row;
    }, subject), `Row "${subject}" not found`);
  } catch (error) {
    error.message += ` among ${JSON.stringify((await visibleRowSubjects()).slice(0, 12))}`;
    throw error;
  }
}

/** Whether a reader heading holds `subject` (the heading also carries alert icons). */
const readerShows = subject => browser.execute(text => [...document.querySelectorAll('h1')].some(h => h.textContent.includes(text)), subject);
const toggle = () => browser.execute(() => document.querySelector('[data-testid="keep-toggle"]')?.getAttribute('aria-pressed'));

async function openAndKeep(subject) {
  await clickRow(subject);
  await wait(async () => (await readerShows(subject)) && (await toggle()) === 'false', `Reader did not open "${subject}"`);
  await browser.execute(() => document.querySelector('[data-testid="keep-toggle"]').click());
  await wait(async () => (await toggle()) === 'true', `"${subject}" was not kept`);
}

/** The count's centre against its bubble's centre, in px. */
const centreDelta = (label) => browser.execute(name => {
  const bubble = [...document.querySelectorAll('[data-testid="keep-bubble"]')].find(b => b.getAttribute('aria-label').startsWith(name));
  const count = bubble.querySelector('[data-testid="keep-count"]');
  const a = bubble.getBoundingClientRect();
  const b = count.getBoundingClientRect();
  return { dx: b.left + b.width / 2 - (a.left + a.width / 2), dy: b.top + b.height / 2 - (a.top + a.height / 2) };
}, label);

async function assertCentred(label, width) {
  const { dx, dy } = await centreDelta(label);
  appendFileSync(resolve(out, 'keep-centre.log'), `${width}px ${label}: dx=${dx} dy=${dy}\n`);
  assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1, `${label} count off centre at ${width}px: dx=${dx} dy=${dy}`);
}

async function shoot(name, selector) {
  await wait(() => browser.execute(sel => {
    const el = document.querySelector(sel);
    return !!el && el.getBoundingClientRect().height > 0;
  }, selector), `${name}: ${selector} not reached`);
  await dismissOnboardingNotice();
  process.env.SHOTS_APP_BINARY = resolve('target/debug/mailvault');
  process.env.SHOTS_OUT = out;
  const { capture, activateAppWindow } = await import('../../scripts/screenshots/capture.js');
  for (const theme of ['light', 'dark']) {
    await setMode(theme);
    activateAppWindow?.();
    await browser.pause(500);
    capture(`${name}-${theme}`);
  }
  writeFileSync(resolve(out, `${name}.reached`), `${selector}\n`);
}

const bubble = label => `[data-testid="keep-bubble"][aria-label^="${label}"]`;
const panelInsideViewport = () => browser.execute(() => {
  const r = document.querySelector('[data-testid="keep-panel"]').getBoundingClientRect();
  return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
});

describe('Keep in bubble capture', function () {
  this.timeout(600_000);
  const restores = [];

  before(async () => {
    await waitForApp();
    await waitForEmails();
    mkdirSync(out, { recursive: true });
    await browser.setWindowRect(0, 0, 1280, 1000);
    await dismissOnboardingNotice();
    await wait(async () => (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, 'the daemon never came up', 180_000);
    await browser.execute(() => {
      window.__SETTINGS_STORE__.setState({ language: 'en', threadMode: 'grouped' });
      window.__SETTINGS_STORE__.getState().setLocalCacheDurationMonths(0);
    });
    await browser.pause(1_500);
    await switchToFolder(account().email, 'INBOX');
    // Mail delivered while the folder is open arrives on its own (as in connected-code-bubble.test.js).
    restores.push(await trackMailbox(browser.mockImap[ACCOUNT], 'INBOX'));
    await seed();
    try {
      await wait(async () => (await visibleRowSubjects()).some(row => row.includes(LENA_SUBJECT)),
        'Seeded mail never reached the list', 120_000);
    } catch (error) {
      error.message += ` among ${JSON.stringify((await visibleRowSubjects()).slice(0, 8))}; active ${JSON.stringify(await browser.execute(() => {
        const state = window.__MAIL_STORE__.getState();
        return [state.activeAccountId, state.activeMailbox, state.emails.length];
      }))}; account ${account().id}`;
      throw error;
    }
  });

  after(async () => { for (const restore of restores) await restore(); });

  it('keeps, groups, reopens and moves', async () => {
    // Keep three from Sam and one from Lena in the reader.
    for (const subject of [LENA_SUBJECT, ...SAM_SUBJECTS]) await openAndKeep(subject);
    await wait(() => browser.execute(() => document.querySelectorAll('[data-testid="keep-stack"]').length === 2), 'Two stacks expected');
    assert.equal(await browser.execute(() => [...document.querySelectorAll('[data-testid="keep-stack"]')]
      .every(s => s.querySelectorAll('[data-testid="keep-bubble"]').length === 1)), true, 'one bubble element per stack');
    assert.equal(await browser.execute(sel => document.querySelector(sel).textContent.trim(), `${bubble('Sam Rivera')} [data-testid="keep-count"]`), '3');
    await assertCentred('Sam Rivera', 1280);
    await assertCentred('Lena Ortiz', 1280);
    await clickRow(SAM_SUBJECTS[0]);
    await wait(async () => (await readerShows(SAM_SUBJECTS[0])) && (await toggle()) === 'true', 'Kept reader did not show pressed');
    await shoot('keep-reader-kept', '[data-testid="keep-toggle"][aria-pressed="true"]');

    // Group: tap Sam, panel with close X and three rows.
    await clickReachable(bubble('Sam Rivera'));
    await wait(() => browser.execute(() => document.querySelectorAll('[data-testid="keep-panel"] [data-testid="keep-row"]').length === 3), 'Group panel rows');
    assert.equal(await browser.execute(() => !!document.querySelector('[data-testid="keep-panel-close"]')), true);
    await shoot('keep-dock-group-expanded', '[data-testid="keep-panel"]');
    // The pointer rests on the bubble, whose hover would keep the panel up: move off it first.
    await $('[data-testid="keep-toggle"]').moveTo();
    await browser.keys('Escape');
    await wait(() => browser.execute(() => !document.querySelector('[data-testid="keep-panel"]')), 'Escape did not fold the group');
    assert.equal(await browser.execute(() => document.querySelectorAll('[data-testid="keep-stack"]').length), 2, 'Escape removes nothing');

    // Single bubble: hover shows the subject and its X.
    await $(bubble('Lena Ortiz')).moveTo();
    await wait(() => browser.execute(subject => document.querySelector('[data-testid="keep-panel"]')?.textContent.includes(subject), LENA_SUBJECT), 'Hover panel');
    await shoot('keep-dock-single-hover', '[data-testid="keep-panel"]');
    await $('[data-testid="keep-toggle"]').moveTo();

    // Reopen from another folder: Sent is active, a Sam row brings back INBOX and that email.
    await switchToFolder(account().email, 'Sent', { requireRows: false });
    await clickReachable(bubble('Sam Rivera'));
    await wait(() => browser.execute(() => document.querySelectorAll('[data-testid="keep-panel"] [data-testid="keep-row"]').length === 3), 'Group panel on Sent');
    await browser.execute(subject => [...document.querySelectorAll('[data-testid="keep-row"]')].find(r => r.textContent.includes(subject)).click(), SAM_SUBJECTS[1]);
    await wait(async () => (await readerShows(SAM_SUBJECTS[1])) && (await toggle()) === 'true', 'Kept email did not reopen');
    assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().activeMailbox), 'INBOX');
    assert.equal(await browser.execute(() => !document.querySelector('[data-testid="keep-panel"]')), true, 'panel collapses');
    await shoot('keep-dock-reopened', '[data-testid="keep-toggle"][aria-pressed="true"]');

    // Move the dock by its grip to the left half.
    await browser.action('pointer').move({ origin: await $('[data-testid="keep-dock-grip"]') }).down()
      .move({ x: -700, y: 40, origin: 'pointer', duration: 300 }).up().perform();
    await wait(() => browser.execute(() => document.querySelector('[data-testid="keep-dock"]').dataset.side === 'left'), 'Dock did not snap left');
    await assertCentred('Sam Rivera', 1280);
    await shoot('keep-dock-left', '[data-testid="keep-dock"][data-side="left"]');

    // Narrow window: panel inside the viewport, count still centred.
    await browser.setWindowRect(0, 0, 375, 800);
    assert.equal(await browser.execute(() => innerWidth), 375, 'Narrow capture must have a 375px webview');
    await assertCentred('Sam Rivera', 375);
    await clickReachable(bubble('Sam Rivera'));
    await wait(() => browser.execute(() => !!document.querySelector('[data-testid="keep-panel-close"]')), 'Narrow panel');
    assert.equal(await panelInsideViewport(), true, 'panel fits the 375px window');
    await shoot('keep-dock-narrow', '[data-testid="keep-panel"]');
    await browser.keys('Escape');
    await browser.setWindowRect(0, 0, 1280, 1000);
  });

  it('shows the toggle in the thread, Notes and Insights readers', async () => {
    await clickRow(THREAD_SUBJECT);
    await wait(() => browser.execute(() => {
      const keep = document.querySelector('[data-testid="keep-toggle"]');
      const close = document.querySelector('[data-testid="close-viewer"]');
      return !!keep && !!close && keep.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING;
    }), 'Thread reader toggle before close');
    await shoot('keep-thread-reader', '[data-testid="keep-toggle"]');

    await clickReachable('[data-testid="open-notes"]');
    await wait(() => browser.execute(() => document.querySelector('[data-testid="notes-board"]')?.dataset.status === 'ready'), 'Notes board', 60_000);
    await wait(async () => {
      if (await browser.execute(() => !!document.querySelector('[data-testid="note-card"]'))) return true;
      await clickReachable('[data-testid="notes-refresh"]');
      return false;
    }, 'Note card never appeared', 90_000);
    await browser.execute(subject => document.querySelector(`[data-testid="note-card"][aria-label="${subject}"]`).click(), NOTE_SUBJECT);
    await wait(() => browser.execute(() => !!document.querySelector('[data-testid="keep-toggle"]') && !!document.querySelector('[data-testid="open-in-window"]')), 'Notes reader tools');
    await shoot('keep-notes-reader', '[data-testid="open-in-window"]');
    await browser.execute(() => document.querySelector('[data-testid="open-notes"]')?.click());

    await openInsights();
    await setInsightsRange('2028-01-01', '2028-01-31');
    await setControl('[data-testid="insights-accounts"]', account().id);
    await waitForInsights();
    await clickReachable('[data-testid="insights-tab-map"]');
    await setControl('.insights-map-section input[type="search"]', SAM.address);
    await clickReachable(`.insights-sender-rows button[aria-label*="${SAM.address}"]`);
    await waitForInsights();
    await clickReachable('[data-testid="insights-tab-activity"]');
    await clickReachable('button[data-date="2028-01-10"]');
    await wait(() => browser.execute(() => document.querySelectorAll('[data-testid="insights-match"]').length >= 1), 'Insights matches', 30_000);
    await clickReachable('[data-testid="insights-match"]');
    await wait(() => browser.execute(() => !!document.querySelector('[data-testid="insights-reader"] [data-testid="keep-toggle"]')), 'Insights reader toggle', 30_000);
    await shoot('keep-insights-reader', '[data-testid="insights-reader"] [data-testid="keep-toggle"]');
  });
});
