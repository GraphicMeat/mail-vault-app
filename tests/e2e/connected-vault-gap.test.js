/**
 * E2E: Settings > Backup shows, on each account's card, the copies the app has
 * shown or cached that are not in the vault, and "Save them now" puts them
 * there (Phase 5, D7). The daemon counts (`vault_gap_count`) and saves
 * (`vault_gap_save`); the row shows what it says.
 *
 * Fixture. luke's mail is dated Jan to Feb 2026 (`stamp(uid)` is 2026-01-01
 * + uid days), outside the default Keep Recent window: under Keep Recent none
 * of it counts (the mode leaves it on the server). The spec puts luke alone in
 * Hoarder, without Premium: Hoarder promises every copy, so every cached
 * header counts, and without Premium the daemon's Hoarder worker does not
 * fill the vault behind the spec's back.
 *
 * The spec relies on luke's Sent, not INBOX. The app caches Sent's headers
 * (for threading) and never fetches its bodies ahead, so Sent stays in the
 * count until the save. INBOX does not: the app's own fetch-ahead pipeline
 * fills INBOX's vault copies under Hoarder in under a second against the
 * local mock, and pausing it (`__PIPELINE_CONTROL__.pauseAll()`, kept) is not
 * a hold, since switching to the active account, an account switch and the
 * `online` handler all resume it. A run once counted 56 (Sent 11, INBOX 45)
 * and one second later 11. Whether INBOX is in the count when it settles is
 * therefore not asserted; every settle read is logged in full.
 *
 * luke's Flaky folder holds 9301, whose body fetch always fails: were its
 * headers cached, the save could never reach 0. The spec checks Flaky is not
 * in the count before relying on that.
 *
 * The unreachable-vault case puts the daemon in the state a vault move puts
 * it in (`vault_close`: the vault gate refuses, and the header cache, which
 * lives in the vault, closes), reopens the panel so the row counts again, and
 * reopens the vault after (`vault_reopen`). The daemon's reachability is the
 * vault gate plus the vault ROOT still being a directory: an unplugged
 * external drive takes the whole vault path away, which the daemon's unit
 * specs cover (`a_vault_lost_since_startup_is_unreachable_and_a_save_refuses_it`).
 * Here the vault is the default location, the app data dir itself, which
 * cannot be taken away under a running app; renaming only its `Maildir` is
 * not an unreachable vault but an empty one (a fresh account has no
 * `Maildir` yet either), so every cached copy counts as missing, correctly.
 * With the header cache closed the count is unknown, with the reason. It
 * runs last, and every spec file starts from a fresh data dir
 * (`resetAppState`), so a failed reopen cannot reach another spec.
 *
 * Every wait is `browser.waitUntil(() => browser.execute(...))`: `$(sel)` and
 * `waitForDisplayed` die on tauri-wd, and a page callback cannot close over a
 * host variable, so everything it needs is passed as an argument.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './mockImap.js';
import { closeSettings, waitForApp, waitForEmails } from './helpers.js';
import { openTab } from './mockBilling.js';

const LUKE = 'luke@mock.test';
// luke's Sent (mockImap.js `mailbox('Sent', ...)`): its vault dir is the same name.
const SENT = 'Sent';
const NONE = 'Every copy this app has shown or cached is in your vault.';
const UNAVAILABLE = 'Your mail storage folder is unavailable';

const wait = (predicate, timeout, message) =>
  browser.waitUntil(predicate, { timeout, interval: 250, timeoutMsg: message });

const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

const vaultRoot = () => join(appDataDir(browser.testDataDir), 'Maildir');

/**
 * Click a Backup sub-tab and wait until it is the selected one. "Backup &
 * Restore" names both the sidebar entry and the first sub-tab, and the sub-tab
 * bar renders after the sidebar, so the last match is the sub-tab (as
 * connected-backup-manual-queue does).
 */
async function clickBackupSubTab(label) {
  const clicked = await browser.execute((wanted) => {
    const matches = [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
      .filter((b) => b.offsetHeight > 0 && b.textContent.trim() === wanted);
    if (!matches.length) return false;
    matches[matches.length - 1].click();
    return true;
  }, label);
  assert.equal(clicked, true, `no "${label}" sub-tab`);
  await wait(() => browser.execute((wanted) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"][aria-selected="true"]')]
    .some((b) => b.textContent.trim() === wanted), label), 5_000, `the "${label}" sub-tab never opened`);
}

function diskSettings() {
  try {
    return JSON.parse(readFileSync(join(appDataDir(browser.testDataDir), 'frontend-settings.json'), 'utf8'))['mailvault-settings']?.state;
  } catch {
    return null;
  }
}

/** One account's not-in-vault row on the Backup Schedule card, as the DOM reports it. */
const gapRow = (accountId) => browser.execute((id) => {
  const row = document.querySelector(`[data-testid="vault-gap-row"][data-account-id="${id}"]`);
  if (!row) return null;
  const save = row.querySelector('[data-testid="vault-gap-save"]');
  return {
    state: row.getAttribute('data-state'),
    count: row.getAttribute('data-count'),
    running: row.getAttribute('data-running'),
    text: (row.innerText || '').replace(/\s*\n\s*/g, ' | '),
    saveDisabled: !save || save.disabled,
    progress: !!row.querySelector('[data-testid="vault-gap-progress"]'),
  };
}, accountId);

/** Vault files in one of the account's folders that carry the archived flag: `4:2,AS.eml` -> `AS`. */
function archivedFiles(accountId, folder) {
  const cur = join(vaultRoot(), accountId, folder, 'cur');
  if (!existsSync(cur)) return [];
  return readdirSync(cur).filter((name) => (name.split(/[:;]2,/)[1] || '').replace(/\.eml$/, '').includes('A'));
}

// Whether the unreachable case closed the vault, so it is reopened whatever happens.
let vaultClosed = false;

/** Reopen the vault the unreachable case closed. */
async function reopenVault() {
  if (!vaultClosed) return;
  const reply = await daemonRpc('vault_reopen', {});
  if (!reply.ok) throw new Error(`vault_reopen refused: ${reply.__error}`);
  vaultClosed = false;
}

describe('Settings > Backup - copies not yet in the vault', function () {
  this.timeout(300_000);

  let lukeId = null;
  let counted = null; // the daemon's count before the save

  before(async function () {
    assert.equal(await waitForApp(), 'ready');
    await waitForEmails();
    await wait(() => browser.execute(() => !!window.__SETTINGS_STORE__ && !!window.__PIPELINE_CONTROL__ && !!window.__PIPELINES__),
      20_000, 'The build must enable VITE_E2E');
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    assert.ok(lukeId, 'luke is not among the mock accounts');

    // Pause the app's body pipelines. Not a hold (see the header): INBOX may
    // still fill, so the spec relies on Sent, which nothing fetches ahead.
    await browser.execute(() => window.__PIPELINE_CONTROL__.pauseAll());
    await wait(() => browser.execute(() => (window.__PIPELINES__?.() || []).every((p) => p.activeSlots <= 0)),
      60_000, 'Background body fetches were still in flight after pausing the pipelines');

    // luke alone in Hoarder. A plain setState: the setter refuses Hoarder
    // without Premium. The store writes the settings file and wakes the daemon
    // itself (notifyFetchModeChanged); the count reads the file fresh.
    await browser.execute((id) => {
      window.__SETTINGS_STORE__.setState((s) => ({ language: 'en', fetchModes: { ...(s.fetchModes || {}), [id]: 'hoarder' } }));
    }, lukeId);
    await wait(async () => diskSettings()?.fetchModes?.[lukeId] === 'hoarder', 15_000,
      'luke\'s Hoarder override never reached the settings file the daemon reads');
    assert.notEqual(diskSettings()?.fetchModePremium, true,
      'With Premium the Hoarder worker would fill the vault behind the spec');

    // The header cache may still be landing (Sent for threading) and the app's
    // pipeline may still be filling INBOX: take the count once two reads a
    // second apart agree and neither is a floor. Every read is logged in full,
    // so a run that fails here shows which folder moved.
    let last = null;
    let reads = 0;
    try {
      await browser.waitUntil(async () => {
        const reply = await daemonRpc('vault_gap_count', { accountId: lukeId });
        reads += 1;
        console.log(`[vault-gap] settle read ${reads}:`, JSON.stringify(reply));
        const same = reply.ok && !!last?.ok && JSON.stringify(last.v) === JSON.stringify(reply.v);
        last = reply;
        return same && reply.v.partial === false;
      }, { timeout: 90_000, interval: 1_000 });
    } catch (e) {
      throw new Error(`luke's count never settled: ${JSON.stringify(last)} (${e.message})`);
    }
    counted = last.v;
    console.log('[vault-gap] before the save:', JSON.stringify(counted));
    assert.equal(counted.vaultReachable, true);
    assert.equal(counted.partial, false,
      `luke's folders are small and fully cached; a floor here would keep the zero case from ever showing: ${JSON.stringify(counted.byMailbox)}`);
    assert.ok(counted.count > 0, 'Nothing of luke\'s is missing from the vault: the fixture no longer makes a gap');
    assert.ok((counted.byMailbox.find((f) => f.mailbox === SENT)?.count || 0) > 0,
      `luke's ${SENT} is not in the count: ${JSON.stringify(counted.byMailbox)}`);
    assert.equal(counted.byMailbox.some((f) => f.mailbox === 'Flaky'), false,
      'Flaky is counted: its 9301 never fetches, so Save them now could never reach 0');
    assert.equal(counted.byMailbox.reduce((n, f) => n + f.count, 0), counted.count);

    // The row counts when the panel opens: open it only now.
    await openTab('Backup & Restore', 'Backup Schedule');
  });

  after(async function () {
    // The vault first: the pipeline resumed below writes into it.
    await reopenVault().catch((e) => console.warn(`[vault-gap] could not reopen the vault: ${e.message}`));
    await browser.execute((id) => {
      window.__SETTINGS_STORE__.setState((s) => {
        const { [id]: _, ...rest } = s.fetchModes || {};
        return { fetchModes: rest };
      });
      window.__PIPELINE_CONTROL__.resumeAll();
    }, lukeId).catch(() => {});
    await closeSettings().catch(() => {});
  });

  it('shows the count of copies not in the vault on the account\'s card', async function () {
    // The row shows what the daemon says now, not a number the spec remembers.
    let seen = null;
    let fresh = null;
    try {
      await wait(async () => {
        seen = await gapRow(lukeId);
        const reply = await daemonRpc('vault_gap_count', { accountId: lukeId });
        fresh = reply.ok ? reply.v : null;
        return seen?.state === 'missing' && !!fresh && seen.count === String(fresh.count);
      }, 60_000);
    } catch (e) {
      throw new Error(`luke's row never showed the daemon's count: row ${JSON.stringify(seen)}, daemon ${JSON.stringify(fresh)} (${e.message})`);
    }
    const phrase = fresh.count === 1 ? '1 copy is not in your vault yet' : `${fresh.count} copies are not in your vault yet`;
    assert.ok(seen.text.includes(phrase), seen.text);
    assert.ok(!seen.text.includes(NONE), seen.text);
    assert.equal(seen.saveDisabled, false, 'Save them now is disabled with copies to save');
    assert.equal(seen.running, 'false');
  });

  it('Save them now puts every copy in the vault, and the count reaches 0', async function () {
    const sentMissing = counted.byMailbox.find((f) => f.mailbox === SENT).count;
    const before = archivedFiles(lukeId, SENT).length;

    assert.equal(await browser.execute((id) => {
      const save = document.querySelector(`[data-testid="vault-gap-row"][data-account-id="${id}"] [data-testid="vault-gap-save"]`);
      if (!save || save.disabled) return false;
      save.scrollIntoView({ block: 'center', behavior: 'instant' });
      save.click();
      return true;
    }, lukeId), true, 'Save them now was missing or disabled');

    let seen = null;
    try {
      await wait(async () => { seen = await gapRow(lukeId); return seen?.state === 'none' && seen.running === 'false'; }, 180_000);
    } catch (e) {
      throw new Error(`the count never reached 0: ${JSON.stringify(seen)} (${e.message})`);
    }
    assert.equal(seen.count, '0');
    assert.ok(seen.text.includes(NONE), seen.text);
    assert.ok(!/could not be saved/.test(seen.text), seen.text);
    assert.equal(seen.progress, false);
    assert.equal(seen.saveDisabled, true, 'Save them now stays enabled with nothing to save');

    // The daemon agrees, and the copies are on disk, as archived copies.
    assert.deepEqual(await daemonRpc('vault_gap_count', { accountId: lukeId }),
      { ok: true, v: { count: 0, vaultReachable: true, partial: false, byMailbox: [] } });
    const gained = archivedFiles(lukeId, SENT).length - before;
    assert.ok(gained >= sentMissing, `${SENT} gained ${gained} archived copies; ${sentMissing} were missing`);
  });

  it('an unreachable vault shows the reason, never everything-in-your-vault, and cannot save', async function () {
    const closed = await daemonRpc('vault_close', {});
    assert.equal(closed.ok, true, `vault_close refused: ${closed.__error}`);
    vaultClosed = true;
    try {
      // Reopen the panel: the row counts again when it mounts. Through the
      // first sub-tab, which sends nothing on mount.
      await clickBackupSubTab('Backup & Restore');
      await wait(async () => (await gapRow(lukeId)) === null, 5_000, 'the Backup Schedule panel never closed');
      await clickBackupSubTab('Backup Schedule');

      let seen = null;
      try {
        await wait(async () => {
          seen = await gapRow(lukeId);
          return seen?.state === 'unreachable' || seen?.state === 'unknown';
        }, 30_000);
      } catch (e) {
        throw new Error(`the row never said the vault is unreachable: ${JSON.stringify(seen)} (${e.message})`);
      }
      assert.ok(seen.text.includes(UNAVAILABLE), seen.text);
      assert.ok(!seen.text.includes(NONE), seen.text);
      assert.equal(seen.saveDisabled, true, 'Save them now is offered into a vault that is not there');

      // The header cache lives in the vault and closed with it: no count, the reason.
      const reply = await daemonRpc('vault_gap_count', { accountId: lukeId });
      assert.equal(reply.ok, true, `vault_gap_count refused: ${reply.__error}`);
      assert.deepEqual(reply.v, { count: null, vaultReachable: false, reason: 'E_VAULT_UNAVAILABLE', partial: true, byMailbox: [] });
    } finally {
      await reopenVault();
    }
    // Reopened, the account counts again.
    const back = await daemonRpc('vault_gap_count', { accountId: lukeId });
    assert.equal(back.ok, true, `vault_gap_count refused after the reopen: ${back.__error}`);
    assert.equal(back.v.vaultReachable, true);
  });
});
