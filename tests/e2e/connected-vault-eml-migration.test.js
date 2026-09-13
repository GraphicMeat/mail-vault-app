/**
 * E2E: a vault written before the `.eml` suffix is swept at startup.
 *
 * Discussion #13, reported on 2.13.1. v2.5.0's changelog said stored messages
 * carry the `.eml` extension. What shipped was a one-time, version-guarded
 * rename of the files already on disk; `build_maildir_filename` kept emitting
 * `<uid>:2,<flags>`, so every message archived over the following four months
 * landed without a suffix, in a vault whose marker already said "migrated".
 *
 * The fix names new files correctly and bumps the marker so the rename runs
 * once more. This spec is about the second half: the vault a real user has now.
 *
 * The seed HAS to be pre-boot — `seedLegacyVault` runs from `beforeSession` in
 * wdio.conf.js, because the sweep happens during the app's setup and there is
 * no way to restart the app inside a session.
 *
 * Two processes sweep: the app (main.rs setup) and the background helper
 * (src-daemon/src/main.rs). This spec asserts the user-visible guarantee, not
 * which of them got there first. The app half is unit-tested separately
 * (`startup_sweeps_a_vault_that_predates_the_eml_suffix`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp } from './helpers.js';
import { appDataDir, LEGACY_EML_UID, LEGACY_EML_NAME } from './mockImap.js';

const LUKE = 'luke@mock.test';

describe('Vault — the .eml sweep', function () {
  this.timeout(120_000);

  let maildir = null;
  let cur = null;

  /** Every file in the seeded INBOX cur/, by name. */
  const names = () => {
    try { return readdirSync(cur).sort(); } catch { return []; }
  };

  before(async function () {
    await waitForApp();
    const accountId = browser.mockAccounts.find((a) => a.email === LUKE).id;
    maildir = join(appDataDir(browser.testDataDir), 'Maildir');
    cur = join(maildir, accountId, 'INBOX', 'cur');
  });

  it('planted a pre-.eml vault before the app booted', async function () {
    // Anti-vacuity. Without the seed every assertion below is about an empty
    // directory and passes for the wrong reason.
    const present = names();
    const seeded = present.some((n) => n === LEGACY_EML_NAME || n === `${LEGACY_EML_NAME}.eml`);
    if (!seeded) {
      throw new Error(`seedLegacyVault never ran: cur/ holds ${present.join(',') || '(nothing)'}. `
        + 'It is wired to the spec filename in wdio.conf.js beforeSession.');
    }
  });

  it('renames the message the old build stored without a suffix', async function () {
    await browser.waitUntil(() => names().includes(`${LEGACY_EML_NAME}.eml`), {
      timeout: 60_000,
      interval: 300,
      timeoutMsg: `${LEGACY_EML_NAME} was never renamed`,
    });

    // The extension-less original is gone, not duplicated: a copy would give
    // the uid two files and the next reader would resolve whichever it saw first.
    expect(names()).not.toContain(LEGACY_EML_NAME);
    expect(names().filter((n) => n.startsWith(`${LEGACY_EML_UID}:`)).length).toBe(1);
  });

  it('keeps the message readable, so the rename moved the bytes and not just the name', async function () {
    const body = readFileSync(join(cur, `${LEGACY_EML_NAME}.eml`), 'utf8');
    expect(body).toContain('Message-ID: <legacy-eml@mock.test>');
    expect(body).toContain('This message was archived by a build that forgot the suffix.');
  });

  it('moves the vault marker on, so the sweep does not walk it again', async function () {
    await browser.waitUntil(() => readFileSync(join(maildir, '.maildir_version'), 'utf8').trim() === '3', {
      timeout: 60_000,
      interval: 300,
      timeoutMsg: 'the version marker still reads 2, so the next start would sweep again',
    });
  });
});
