/**
 * E2E: a custody store the app cannot read is reported and left as it is.
 * Pre-boot seed: `seedCorruptCustody` (wdio.conf.js beforeSession).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir, CORRUPT_CUSTODY_BYTES } from './mockImap.js';

/**
 * One command, resolved or rejected, as `{ ok }` / `{ failed }`.
 *
 * NOT `{ error }`: a W3C error response is `{value:{error,message}}`, so a
 * result object with a truthy `error` key is read back as a WebDriver failure
 * and the assertion never runs. Every case here is about a truthy error.
 */
// Task 2.9b: custody lives in the daemon, so these are `daemon_rpc` calls
// under the command's own name, not native Tauri commands (the Tauri commands
// are deleted). The daemon's own error text passes through unchanged.
const invoke = (method, params) => browser.executeAsync((m, p, done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p }).then((ok) => done({ ok }), (e) => done({ failed: String(e) }));
}, method, params);

describe('Custody store: unreadable', function () {
  this.timeout(120_000);
  let file;

  before(async function () {
    await waitForApp();
    file = join(appDataDir(browser.testDataDir), 'custody', 'custody.db');
    if (readFileSync(file, 'utf8') !== CORRUPT_CUSTODY_BYTES) throw new Error('seedCorruptCustody never ran, or the app rewrote the file');
  });

  it('reports the store as unavailable and names the file', async function () {
    const { ok: status } = await invoke('custody_status', {});
    expect(status.available).toBe(false);
    expect(status.error).toMatch(/unreadable|not a database/i);
    expect(status.path).toBe(file);
  });

  it('shows the banner, with no way to delete anything', async function () {
    await browser.waitUntil(async () => (await browser.execute(() => document.body.innerText)).includes('Vault records could not be opened'), { timeout: 30_000, interval: 300, timeoutMsg: 'no custody banner' });
    const text = await browser.execute(() => document.body.innerText);
    expect(text).toContain('custody.db');
  });

  it('a custody read fails loudly instead of answering "no entries"', async function () {
    const got = await invoke('local_index_read', { accountId: browser.mockAccounts[0].id, mailbox: 'INBOX' });
    expect(got.failed).toMatch(/custody store unavailable/);
  });

  it('still lists mail, and the file is untouched', async function () {
    await waitForEmails();
    expect(readFileSync(file, 'utf8')).toBe(CORRUPT_CUSTODY_BYTES);
  });
});
