/**
 * E2E: OpenPGP decryption in the daemon.
 *
 * luke's Flaky folder holds one PGP/MIME message (uid 9303) that GnuPG
 * encrypted to a TEST-ONLY key (src-core/tests/fixtures). Before the key is
 * imported the reader shows the missing-key notice, never ciphertext; after
 * importing it through Settings > Encryption the same message opens decrypted
 * with its badge, and the decrypted copy is on disk next to the encrypted
 * original in the vault.
 *
 * Keys come from MAILVAULT_TEST_PGP_KEYS (wdio.conf.js), never the runner's
 * real keychain.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { appDataDir, PGP_TEST_KEY, PGP_SUBJECT, PGP_SECRET_TEXT } from './mockImap.js';

const LUKE = 'luke@mock.test';
const LUKE_ID = '11111111-1111-4111-8111-111111111111';
const UID = 9303;

describe('OpenPGP', function () {
  this.timeout(180_000);

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => (r.innerText || '').includes(needle));
    if (!row || row.offsetHeight === 0) return false;
    row.click();
    return true;
  }, subject);

  const present = (testId) => browser.execute((id) => !!document.querySelector(`[data-testid="${id}"]`), testId);

  const readerText = () => browser.execute(() => document.querySelector('.email-content')?.innerText || '');

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'Flaky');
    await browser.waitUntil(async () => clickRow(PGP_SUBJECT), {
      timeout: 30_000, interval: 300, timeoutMsg: `luke's Flaky folder never listed "${PGP_SUBJECT}"`,
    });
  });

  after(async function () {
    try { await closeSettings(); } catch { /* best effort */ }
    // No key may leak into a later spec file.
    rmSync(join(browser.testDataDir, 'pgp-keys.json'), { force: true });
  });

  it('shows the missing-key notice instead of ciphertext', async function () {
    await browser.waitUntil(async () => present('pgp-locked'), {
      timeout: 60_000, interval: 300, timeoutMsg: 'the reader never showed the missing-key notice',
    });
    expect(await browser.execute(() => document.body.innerText.includes('BEGIN PGP MESSAGE'))).toBe(false);
  });

  it('imports the TEST-ONLY key in Settings > Encryption', async function () {
    await openSettings();
    expect(await clickSettingsNav('Encryption')).toBe(true);
    await browser.waitUntil(async () => present('pgp-no-keys'), { timeout: 10_000, timeoutMsg: 'the key list never loaded' });
    // A controlled textarea: set it the way React hears it, typing 900 chars is slow.
    await browser.execute((armored) => {
      const area = document.querySelector('[data-testid="settings-page"] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, armored);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, PGP_TEST_KEY);
    await browser.execute(() => {
      [...document.querySelectorAll('[data-testid="settings-page"] button')]
        .find((b) => b.textContent.trim() === 'Import key')?.click();
    });
    await browser.waitUntil(async () => present('pgp-key-row'), {
      timeout: 30_000, interval: 300, timeoutMsg: 'the imported key never listed',
    });
    const row = await browser.execute(() => document.querySelector('[data-testid="pgp-key-row"]').innerText);
    expect(row).toContain('pgp-test@mock.test');
    expect(row).toContain('85D0 EC45 B7C4 AA14');
    await closeSettings();
  });

  it('opens the same message decrypted, and keeps the decrypted copy in the vault', async function () {
    await switchToFolder(LUKE, 'Flaky');
    expect(await clickRow(PGP_SUBJECT)).toBe(true);
    await browser.waitUntil(async () => (await readerText()).includes(PGP_SECRET_TEXT), {
      timeout: 60_000, interval: 300, timeoutMsg: 'the decrypted body never rendered',
    });
    expect(await present('pgp-decrypted')).toBe(true);
    expect(await present('pgp-locked')).toBe(false);
    const copy = join(appDataDir(browser.testDataDir), 'Maildir', LUKE_ID, 'Flaky', '.decrypted', `${UID}.eml`);
    await browser.waitUntil(() => existsSync(copy), { timeout: 10_000, timeoutMsg: `no decrypted copy at ${copy}` });
  });

  it('removes the key again', async function () {
    await openSettings();
    expect(await clickSettingsNav('Encryption')).toBe(true);
    await browser.waitUntil(async () => present('pgp-key-row'), { timeout: 10_000 });
    await browser.execute(() => document.querySelector('[data-testid="pgp-key-row"] button[aria-label="Remove key"]').click());
    await browser.waitUntil(async () => present('pgp-no-keys'), { timeout: 30_000, timeoutMsg: 'the key never went away' });
    await closeSettings();
  });
});
