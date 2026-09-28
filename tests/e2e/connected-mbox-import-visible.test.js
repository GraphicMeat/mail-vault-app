/**
 * E2E: mail imported from an MBOX file shows up in the folder it went into.
 *
 * The importer used to number messages from `max local uid + 1`. On an
 * account whose vault does not hold every server message, that is a uid the
 * server already uses: the list keeps the server row for a uid and drops the
 * vault row, so the imported message never appeared, and the server message
 * under that uid opened the imported body. Imports now number from
 * `IMPORT_UID_BASE`, a range no server reaches.
 *
 * The native open panel cannot be driven (see
 * connected-import-export-daemon.test.js), so the import is the same
 * `daemon_rpc` the Import MBOX button sends.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadApp, switchToFolder, visibleRowSubjects, waitForApp, waitForEmails } from './helpers.js';

const LUKE = 'luke@mock.test';

const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

describe('MBOX import shows the imported mail', function () {
  this.timeout(180_000);

  let workDir = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    workDir = mkdtempSync(join(tmpdir(), 'mv-mbox-visible-e2e-'));
  });

  after(function () {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('lists every imported message in the target INBOX after a reload', async function () {
    const lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();

    // Dated now, so they sort to the top of the list and need no scrolling.
    const date = new Date().toUTCString().replace('GMT', '+0000');
    const subjects = ['Takeout import one', 'Takeout import two'];
    const mbox = subjects.map((subject, i) => [
      'From takeout@gmail.test Mon Jan  1 00:00:00 2026',
      'From: Takeout <takeout@gmail.test>',
      `To: ${LUKE}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: <takeout-visible-${i}@gmail.test>`,
      '',
      `${subject} - body`,
      '',
      '',
    ].join('\n')).join('');
    const mboxPath = join(workDir, 'takeout.mbox');
    writeFileSync(mboxPath, mbox);

    const resp = await daemonRpc('import_mbox', { accountId: lukeId, mailbox: 'INBOX', sourcePath: mboxPath });
    expect(resp.ok).toBe(true);
    expect(resp.v.emailCount).toBe(2);

    await reloadApp();
    await switchToFolder(LUKE, 'INBOX');

    let rows = [];
    await browser.waitUntil(async () => {
      rows = await visibleRowSubjects();
      return subjects.every((s) => rows.some((r) => r.includes(s)));
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `imported subjects never listed in ${LUKE} INBOX; rows: ${JSON.stringify(rows).slice(0, 600)}`,
    });
  });
});
