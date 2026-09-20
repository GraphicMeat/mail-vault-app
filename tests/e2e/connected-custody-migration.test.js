/**
 * E2E: the per-mailbox JSON custody records are imported into the custody
 * store once, losslessly, and every writer records there from then on.
 *
 * The seed HAS to be pre-boot (`seedLegacyCustody`, wdio.conf.js
 * beforeSession): the import runs during setup and the app cannot be
 * restarted inside a session.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import {
  appDataDir, LEGACY_CUSTODY_UID, LEGACY_CUSTODY_ENTRY, LEGACY_NESTED_ENTRY,
  LEGACY_HEADER_UID, LEGACY_HEADER, LEGACY_HEADER_MAILBOX,
} from './mockImap.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';

/**
 * One command, resolved or rejected, as `{ ok }` / `{ failed }`.
 *
 * NOT `{ error }`: a W3C error response is `{value:{error,message}}`, so a
 * result object with a truthy `error` key is read back as a WebDriver failure
 * and the assertion never runs (the corrupt-store spec below asserts on a
 * rejection, which is exactly the case that trips it).
 */
const invoke = (command, args) => browser.executeAsync((c, a, done) => {
  window.__TAURI_INTERNALS__.invoke(c, a).then((ok) => done({ ok }), (e) => done({ failed: String(e) }));
}, command, args);

const readIndex = async (accountId, mailbox) => {
  const got = await invoke('daemon_rpc', { method: 'local_index_read', params: { accountId, mailbox } });
  return got.failed ? got : { entries: got.ok ? JSON.parse(got.ok) : null };
};

const byUid = (entries) => [...(entries || [])].sort((a, b) => a.uid - b.uid);
const retired = (dir, name) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${name}.pre-db-`)) : []);

// ── Copied verbatim from connected-search-index.test.js ──────────────────
const rows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
    text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
    icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
  })));

const rowFor = async (subject) => (await rows()).find((r) => r.text.includes(subject));

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

const clickBarButton = (title) => browser.execute((t) => {
  const btn = document.querySelector(`button[title="${t}"]`);
  if (!btn || btn.offsetHeight === 0) return false;
  btn.click();
  return true;
}, title);

async function archive(subject) {
  expect(await clickRowCheckbox(subject)).toBe(true);
  expect(await clickBarButton('Archive selected')).toBe(true);
  await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('archived'), {
    timeout: 60_000, interval: 300,
    timeoutMsg: `"${subject}" never became an archived row`,
  });
}
// ────────────────────────────────────────────────────────────────────────

describe('Custody store: migration', function () {
  this.timeout(300_000);
  let luke; let vader; let data; let inbox; let nested; let maildirInbox; let vaderSubject = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    luke = browser.mockAccounts.find((a) => a.email === LUKE);
    vader = browser.mockAccounts.find((a) => a.email === VADER);
    data = appDataDir(browser.testDataDir);
    inbox = join(data, 'maildir', luke.id, 'INBOX');
    nested = join(data, 'maildir', luke.id, 'Projects', '2026');
    maildirInbox = join(data, 'Maildir', luke.id, 'INBOX');
  });

  it('planted the JSON records before the app booted', function () {
    // Anti-vacuity: without the seed every assertion below is about nothing.
    if (!existsSync(join(inbox, 'local-index.json')) && retired(inbox, 'local-index.json').length === 0) {
      throw new Error(`seedLegacyCustody never ran: ${inbox} holds ${existsSync(inbox) ? readdirSync(inbox).join(',') : '(nothing)'}`);
    }
  });

  it('imports every entry losslessly, nested paths included, and retires the files', async function () {
    await browser.waitUntil(async () => retired(inbox, 'local-index.json').length === 1, { timeout: 60_000, interval: 300, timeoutMsg: 'the INBOX index file was never retired' });
    expect(existsSync(join(inbox, 'local-index.json'))).toBe(false);
    expect(readFileSync(join(inbox, retired(inbox, 'local-index.json')[0]), 'utf8')).toBe(JSON.stringify([LEGACY_CUSTODY_ENTRY]));
    expect(retired(nested, 'local-index.json').length).toBe(1);
    expect(existsSync(join(maildirInbox, 'archived_headers.json'))).toBe(false);
    expect(retired(maildirInbox, 'archived_headers.json').length).toBe(1);
    expect(existsSync(join(data, 'custody', 'custody.db'))).toBe(true);

    const got = await readIndex(luke.id, 'INBOX');
    expect(got.failed).toBeUndefined();
    expect(byUid(got.entries).find((e) => e.uid === LEGACY_CUSTODY_UID)).toEqual(LEGACY_CUSTODY_ENTRY);
    const nestedRead = await readIndex(luke.id, 'Projects/2026');
    expect(nestedRead.entries).toEqual([LEGACY_NESTED_ENTRY]);
    const status = await invoke('daemon_rpc', { method: 'custody_status', params: {} });
    expect(status.ok.available).toBe(true);
  });

  it('imports mailbox and email-list JSON into SQL and snapshots compatibility mirrors', async function () {
    const mailboxDir = join(data, 'mailboxes', luke.id);
    const cacheBase = `${luke.id.replace(/[^a-z0-9]/gi, '_')}_${LEGACY_HEADER_MAILBOX.replace(/[^a-z0-9]/gi, '_')}`;
    const cacheDir = join(data, 'email_cache', cacheBase);
    await browser.waitUntil(async () => retired(mailboxDir, 'mailboxes.json').length === 1, {
      timeout: 60_000, interval: 300, timeoutMsg: 'mailboxes.json was never retired',
    });
    expect(retired(cacheDir, '_meta.json').length).toBe(1);
    expect(retired(cacheDir, `${LEGACY_HEADER_UID}.json`).length).toBe(1);
    expect(existsSync(join(cacheDir, `${LEGACY_HEADER_UID}.json`))).toBe(true);

    const boxes = await invoke('daemon_rpc', { method: 'load_mailbox_cache', params: { accountId: luke.id } });
    expect(boxes.failed).toBeUndefined();
    expect(JSON.parse(boxes.ok).mailboxes[0].path).toBe('INBOX');
    const headers = await invoke('daemon_rpc', {
      method: 'load_email_cache_by_uids',
      params: { accountId: luke.id, mailbox: LEGACY_HEADER_MAILBOX, uids: [LEGACY_HEADER_UID] },
    });
    expect(headers.failed).toBeUndefined();
    expect(headers.ok).toEqual([LEGACY_HEADER]);
  });

  it('removes a cached UID in SQL so it cannot return on the next mailbox read', async function () {
    const removed = await invoke('daemon_rpc', {
      method: 'save_email_cache',
      params: {
        accountId: luke.id,
        mailbox: LEGACY_HEADER_MAILBOX,
        data: JSON.stringify({ emails: [], totalEmails: 0, removedUids: [LEGACY_HEADER_UID] }),
      },
    });
    expect(removed.failed).toBeUndefined();
    const after = await invoke('daemon_rpc', {
      method: 'load_email_cache_by_uids',
      params: { accountId: luke.id, mailbox: LEGACY_HEADER_MAILBOX, uids: [LEGACY_HEADER_UID] },
    });
    expect(after.ok).toEqual([]);
  });

  it('the imported record reaches the row: the message shows as the only copy', async function () {
    await switchToFolder(LUKE, 'INBOX');
    await browser.waitUntil(async () => !!(await rowFor('Recorded by the JSON index')), { timeout: 60_000, interval: 300, timeoutMsg: 'the seeded vault message never listed' });
    const row = await rowFor('Recorded by the JSON index');
    expect(row.icon).toMatch(/^local-only/); // serverDeleted: true came through the import
  });

  it('archiving records in the store, not in a file', async function () {
    const subject = (await rows()).map((r) => r.text).find((t) => /Luke message \d+/.test(t) && !/Recorded/.test(t)).match(/Luke message \d+/)[0];
    await archive(subject);
    await browser.waitUntil(async () => {
      const got = await readIndex(luke.id, 'INBOX');
      return (got.entries || []).some((e) => e.subject === subject && e.source === 'local');
    }, { timeout: 60_000, interval: 300, timeoutMsg: `"${subject}" never got a custody entry` });
    expect(existsSync(join(inbox, 'local-index.json'))).toBe(false);
  });

  it("vader's archive lands in vader's records only", async function () {
    await switchToFolder(VADER, 'INBOX');
    const subject = (await rows()).map((r) => r.text).find((t) => /Vader message \d+/.test(t)).match(/Vader message \d+/)[0];
    vaderSubject = subject;
    await archive(subject);
    await browser.waitUntil(async () => ((await readIndex(vader.id, 'INBOX')).entries || []).some((e) => e.subject === subject), { timeout: 60_000, interval: 300, timeoutMsg: `"${subject}" never got a custody entry` });
    const lukes = (await readIndex(luke.id, 'INBOX')).entries || [];
    expect(lukes.some((e) => e.subject === subject)).toBe(false);
    expect(lukes.some((e) => e.uid === LEGACY_CUSTODY_UID)).toBe(true);
  });

  it('deleting the vault copy removes its record', async function () {
    // The seam under test is maildir_delete_many → the store (Task 5); the
    // command is driven directly so the case does not depend on a menu path.
    const entry = ((await readIndex(vader.id, 'INBOX')).entries || []).find((e) => e.subject === vaderSubject);
    expect(entry).toBeTruthy();
    const r = await invoke('daemon_rpc', { method: 'maildir_delete_many', params: { accountId: vader.id, mailbox: 'INBOX', uids: [entry.uid] } });
    expect(r.failed).toBeUndefined();
    expect(r.ok.removed).toBe(1);
    const after = (await readIndex(vader.id, 'INBOX')).entries || [];
    expect(after.some((e) => e.uid === entry.uid)).toBe(false);
    // Luke's records are untouched by vader's delete.
    const lukes = (await readIndex(luke.id, 'INBOX')).entries || [];
    expect(lukes.some((e) => e.uid === LEGACY_CUSTODY_UID)).toBe(true);
  });
});
