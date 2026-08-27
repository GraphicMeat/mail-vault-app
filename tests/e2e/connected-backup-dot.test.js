/**
 * E2E: the backup-drive dot — what it is painted in, who it belongs to, and
 * whether the viewer agrees with the row.
 *
 * The dot is a MODIFIER on the custody glyph: it says "the external mirror has
 * this too", and it rides on all three base states (server blue, vault emerald,
 * only-copy gold). Three defects shipped together and this file pins all three.
 *
 *  1. It was painted `--mail-local` — Vault Emerald, the "on your disk" token —
 *     so a server-only row rendered a blue cloud wearing a GREEN pip directly
 *     above the words "Not saved to your vault yet". One visual channel
 *     answering two questions.
 *  2. `EmailViewer` never passed `backedUp` into `describeMessageState`, so the
 *     custody band defaulted to "no dot" and could not mention the drive, while
 *     `ConnectedStateIcon` in the sender line 40px below it read the store and
 *     did. Same message, two statements.
 *  3. The mirror key was `<accountId>:<uid>`, and a uid names a message only
 *     inside ONE mailbox. The INBOX view merges Sent copies into its threads
 *     (getChatEmails), so Sent uid 7 was answered by INBOX's mirror entry 7 —
 *     a message that had never been backed up wore a filled dot.
 *
 * The fixture is the mock scenario's own collision. "Cross folder thread check"
 * is an INBOX message (uid 42) whose reply lives in Sent under uid 8, and the
 * thread row's icon describes that reply — while luke's INBOX holds its own,
 * unrelated uid 8. Planting ONLY the INBOX side in the mirror makes defect 3
 * visible and is otherwise inert.
 *
 * `SENT_THREAD_SUBJECT` (Sent uids 6+7) is deliberately NOT used: a thread with
 * no INBOX member is filtered out of the INBOX list entirely, so it is only
 * reachable from the unified Sent view.
 *
 * The mirror is written by hand rather than by running `backup_run_account`:
 * `scan_external_uids` reads filenames, so a planted `<uid>:2,.eml` is exactly
 * what a real run would leave, and no server fetch has to be waited on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { CROSS_FOLDER_SUBJECT } from './mockImap.js';

const LUKE = 'luke@mock.test';

// uid 8 is the whole fixture. It exists in luke's INBOX ("Luke message 8") AND
// in luke's Sent folder, where it is the reply that merges into the
// "Cross folder thread check" conversation — so the same number names two
// different messages that are on screen at the same time. Only the INBOX side
// is mirrored.
const MIRRORED_UID = 8;
const UNMIRRORED_UID = 9;

// luke's Archive folder, which is a plain server folder here — not the vault.
// Rows outside INBOX carry no folder tag of their own (only the INBOX view's
// Sent merge stamps one), so this is the fallback-to-active-mailbox path.
const ARCHIVE_UID = 2;
const ARCHIVE_SUBJECT = `Luke archive ${ARCHIVE_UID}`;

const subjectOf = (uid) => `Luke message ${uid}`;

const eml = (uid) => [
  `From: Sender ${uid} <sender${uid}@example.com>`,
  `To: ${LUKE}`,
  `Subject: ${subjectOf(uid)}`,
  `Message-ID: <mirror-${uid}@mock.test>`,
  'Date: Thu, 19 Mar 2026 22:36:07 +0000',
  '',
  `Body of luke message ${uid}.`,
  '',
].join('\r\n');

describe('The backup-drive dot', function () {
  this.timeout(300_000);

  let backupRoot = null;

  /**
   * `browser.execute()` serializes without awaiting, so a Tauri invoke always
   * came back `{}` — see feedback_browser_execute_never_awaits_an_async_callback.
   */
  function invoke(cmd, args) {
    return browser.executeAsync((c, a, done) => {
      window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
    }, cmd, args);
  }

  /** Every rendered row, flattened the way the other icon specs read them. */
  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')]
      .filter((r) => r.offsetHeight > 0)
      .map((row) => ({
        text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
        threadCount: Number(row.getAttribute('data-thread-count') || 1),
        icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
        dot: row.querySelector('[data-dot]')?.getAttribute('data-dot') || null,
      })));

  /**
   * Page the virtualized list until a row matching `subject` is rendered, then
   * return it. The list holds ~46 rows and draws a window of them, so a row
   * that is merely absent from the DOM is not a missing row.
   */
  async function findRow(subject) {
    let found = null;
    // Page down and WRAP. Paging one way only meant a row above the current
    // scroll position — every earlier test in this file leaves the list part
    // way down — could never be reached. Sent-merged thread rows are also built
    // after the list paints, so this has to keep looking, not look once.
    await browser.waitUntil(
      async () => {
        found = (await rows()).find((r) => r.text.includes(subject)) || null;
        if (found) return true;
        await browser.execute(() => {
          const list = [...document.querySelectorAll('div')]
            .find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
          if (!list) return;
          const next = list.scrollTop + list.clientHeight;
          list.scrollTop = next >= list.scrollHeight - list.clientHeight ? 0 : next;
        });
        return false;
      },
      { timeout: 90_000, interval: 500, timeoutMsg: `no row for "${subject}"` }
    );
    return found;
  }

  /** Click that row and wait for the viewer's custody band to describe it. */
  async function openRow(subject) {
    await findRow(subject);
    await browser.execute((subj) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(subj));
      if (row) row.click();
    }, subject);
    await browser.waitUntil(
      async () => (await band()) !== null,
      { timeout: 30_000, interval: 500, timeoutMsg: `no custody band after opening "${subject}"` }
    );
    return band();
  }

  const band = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="email-custody-band"]');
    return el ? { tone: el.getAttribute('data-tone'), text: (el.innerText || '').replace(/\s+/g, ' ').trim() } : null;
  });

  /**
   * Force a rescan of the mirror. The scan is keyed on
   * (account, mailbox, unifiedInbox, archivedEmailIds) — a backup location
   * saved after the list painted is not one of those, so a folder round-trip is
   * how a user would see it too.
   */
  async function rescan() {
    await switchToFolder(LUKE, 'Archive');
    await switchToFolder(LUKE, 'INBOX');
    await waitForEmails();
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    backupRoot = mkdtempSync(join(tmpdir(), 'mv-backup-dot-'));
    const mirror = join(backupRoot, LUKE, 'INBOX', 'cur');
    mkdirSync(mirror, { recursive: true });
    // ONLY the INBOX side. luke's Sent mirror is deliberately absent, which is
    // a scanned-and-empty answer, not an unknown one.
    writeFileSync(join(mirror, `${MIRRORED_UID}:2,.eml`), eml(MIRRORED_UID));
    mkdirSync(join(backupRoot, LUKE, 'Sent', 'cur'), { recursive: true });
    const archiveMirror = join(backupRoot, LUKE, 'Archive', 'cur');
    mkdirSync(archiveMirror, { recursive: true });
    writeFileSync(join(archiveMirror, `${ARCHIVE_UID}:2,.eml`), eml(ARCHIVE_UID));

    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    console.log('[backup-dot] backup_save_external_location ->', JSON.stringify(loc));

    await rescan();
  });

  after(async function () {
    // Every later spec in the suite reads these icons. A location left pointing
    // at a deleted temp dir turns every dot hollow for all of them.
    await invoke('backup_clear_external_location', {});
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('gives a mirrored INBOX row a filled dot', async function () {
    const row = await findRow(subjectOf(MIRRORED_UID));
    expect(row.dot).toBe('filled', `row was ${JSON.stringify(row)}`);
    expect(row.icon).toBe('server-only-backed-up');
  });

  it('gives a row the mirror does not hold no dot at all', async function () {
    // The scan read this mailbox, so absence here is a positive claim — it must
    // not render as the hollow "could not determine" dot.
    const row = await findRow(subjectOf(UNMIRRORED_UID));
    expect(row.dot).toBe(null, `row was ${JSON.stringify(row)}`);
    expect(row.icon).toBe('server-only');
  });

  // Defect 3. Before the key carried a mailbox this row wore a filled dot it
  // had never earned, borrowed from INBOX uid 7.
  it('does not let an INBOX mirror entry answer for a Sent row with the same uid', async function () {
    // The row's icon describes the thread's latest message, which is the Sent
    // reply (uid 8) — not the INBOX root it is filed under.
    const row = await findRow(CROSS_FOLDER_SUBJECT);
    expect(row.threadCount).toBeGreaterThan(1);
    expect(row.dot).toBe(
      null,
      `the thread's Sent reply claims the backup drive has it, borrowed from INBOX uid ${MIRRORED_UID}: ${JSON.stringify(row)}`
    );
  });

  // Defect 1. The dot rides on every base glyph, so it must carry none of their
  // colours. Compared against live computed values, not class names.
  it('paints the filled dot in no custody colour', async function () {
    await findRow(subjectOf(MIRRORED_UID));
    const seen = await browser.execute(() => {
      const dot = document.querySelector('[data-dot="filled"]');
      if (!dot) return null;
      const probe = (token) => {
        const el = document.createElement('span');
        el.style.backgroundColor = `var(${token})`;
        document.body.appendChild(el);
        const c = getComputedStyle(el).backgroundColor;
        el.remove();
        return c;
      };
      return {
        dot: getComputedStyle(dot).backgroundColor,
        local: probe('--mail-local'),
        server: probe('--mail-server'),
        onlyCopy: probe('--mail-only-copy'),
      };
    });
    expect(seen).not.toBe(null, 'no filled dot was rendered');
    // Without this the test passes vacuously on a class that never compiled:
    // an unstyled dot is transparent, and transparent differs from all three.
    expect(seen.dot).not.toBe('rgba(0, 0, 0, 0)', `the filled dot has no fill at all: ${JSON.stringify(seen)}`);
    expect(seen.dot).not.toBe(seen.local, `the backup dot is painted Vault Emerald: ${JSON.stringify(seen)}`);
    expect(seen.dot).not.toBe(seen.server, JSON.stringify(seen));
    expect(seen.dot).not.toBe(seen.onlyCopy, JSON.stringify(seen));
  });

  // Defect 2, both halves: the band has to mention the drive at all, and it has
  // to say the same thing the row's own icon says.
  it('makes the viewer band agree with the row it opened', async function () {
    const row = await findRow(subjectOf(MIRRORED_UID));
    const opened = await openRow(subjectOf(MIRRORED_UID));
    expect(row.icon).toBe('server-only-backed-up');
    expect(opened.tone).toBe('server');
    expect(opened.text).toContain('backup drive');
  });

  // Defect 2's copy half. "On the server and backup drive" names two places,
  // neither of them the vault, and the bold line is what a scanning eye reads.
  it('names the vault absence in the band, not only in the tooltip detail', async function () {
    const opened = await openRow(subjectOf(MIRRORED_UID));
    expect(opened.text.toLowerCase()).toContain('not in your vault');
  });

  // Recorded honestly: this one PASSES against the broken build too — a band
  // that never mentions the drive trivially never mentions it wrongly. It is a
  // guard against the opposite future regression, not evidence for this fix.
  it('leaves an unmirrored row saying nothing about a drive', async function () {
    const opened = await openRow(subjectOf(UNMIRRORED_UID));
    expect(opened.text).not.toContain('backup drive');
    expect(opened.text.toLowerCase()).toContain('vault');
  });

  // The header line beside the meter. "1,213 of 1,630 loaded in your vault"
  // read as a download progress bar, one line under a count whose "of" meant
  // the SERVER total instead.
  // A row in any folder but INBOX carries no `_mailbox` of its own, so its
  // scope falls back to the folder on screen. Keyed by uid alone this folder was
  // answered by whatever else happened to hold uid 2.
  it('answers a row in another folder from that folder\'s own mirror', async function () {
    await switchToFolder(LUKE, 'Archive');
    await waitForEmails();
    const row = await findRow(ARCHIVE_SUBJECT);
    expect(row.dot).toBe('filled', `row was ${JSON.stringify(row)}`);
    await switchToFolder(LUKE, 'INBOX');
    await waitForEmails();
  });

  it('leads the share line with the vault, not with a bare count', async function () {
    const text = await browser.execute(() =>
      document.querySelector('[data-testid="email-list-vault-share"]')?.textContent?.trim() ?? null);
    expect(text).not.toBe(null, 'no vault share line rendered');
    expect(text).toMatch(/^Vault: [\d,]+ of [\d,]+ loaded$/);
  });
});
