/**
 * E2E (Graph conf): folder storage keys are locale-independent.
 *
 * The mock mailbox is German ("Gesendete Elemente"). The sidebar must key the
 * folder as `Sent` (data-path), label it in the UI language, open it through
 * that key, and cache its headers under `<account>_Sent`, never under a word
 * from the server's or the UI's language.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { GRAPH_ACCOUNT_ID, GRAPH_EMAIL } from './mockGraph.js';

const folderRows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="sidebar"] [data-testid="folder-row"]')]
    .map((r) => ({ path: r.getAttribute('data-path'), label: r.textContent.trim() })));

const KEYS = ['Archive', 'Drafts', 'INBOX', 'Junk', 'Projekte', 'Sent', 'Trash'];

describe('Graph folder storage keys', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('keys the well-known folders by English words whatever the mailbox calls them', async function () {
    await browser.waitUntil(async () => (await folderRows()).length >= KEYS.length, { timeout: 30_000, timeoutMsg: 'folder rows never drew' });
    const rows = await folderRows();
    expect(rows.map((r) => r.path).sort()).toEqual(KEYS);
  });

  it('labels them in the UI language, not the server language', async function () {
    const rows = await folderRows();
    const label = Object.fromEntries(rows.map((r) => [r.path, r.label]));
    expect(label.Sent).toMatch(/^Sent/);
    expect(label.Trash).toMatch(/^Trash/);
    expect(label.Junk).toMatch(/^Junk/);
    expect(label.Projekte).toMatch(/^Projekte/);
    expect(JSON.stringify(rows)).not.toContain('Gesendete');
    expect(JSON.stringify(rows)).not.toContain('Gelöschte');
  });

  it('opens Sent through its key and caches its headers under it', async function () {
    await switchToFolder(GRAPH_EMAIL, 'Sent');
    await waitForEmails();
    // visibleRowSubjects() returns each row's whole innerText, sender and date
    // included ("| To: Recipient 1 | Aug 31 | Gesendete Elemente message 1 |"),
    // so the subject is matched inside it, not at its start.
    const subjects = await visibleRowSubjects();
    expect(subjects.some((s) => s.includes('Gesendete Elemente message'))).toBe(true);

    const cacheDir = join(appDataDir(browser.testDataDir), 'email_cache');
    const sentDir = join(cacheDir, `${GRAPH_ACCOUNT_ID.replace(/-/g, '_')}_Sent`);
    await browser.waitUntil(() => existsSync(sentDir), { timeout: 30_000, timeoutMsg: `no ${sentDir}` });
    const dirs = readdirSync(cacheDir);
    expect(dirs.filter((n) => /Gesendet|Sent_Items|Sent Items/.test(n))).toEqual([]);
  });
});
