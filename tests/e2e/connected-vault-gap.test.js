/**
 * E2E: Settings > Backup shows, on each account's card, the copies the app has
 * shown or cached that are not in the vault, and "Save them now" puts them
 * there (Phase 5, D7). The daemon counts (`vault_gap_count`) and saves
 * (`vault_gap_save`); the row shows what it says.
 *
 * Fixture. luke's INBOX (41 messages dated Jan to Feb 2026: `stamp(uid)` is
 * 2026-01-01 + uid days) lies outside the default Keep Recent window, so the
 * app lists its headers and never downloads a body: none of it is in the
 * vault, and under Keep Recent none of it counts (the mode leaves it on the
 * server). The spec puts luke alone in Hoarder, without Premium: Hoarder
 * promises every copy, so every cached header counts, and without Premium no
 * Hoarder worker fills the vault behind the spec's back. The app's own body
 * pipeline is paused (`__PIPELINE_CONTROL__`, as connected-insights does), so
 * nothing but the save writes a body while the spec watches.
 *
 * luke's Flaky folder holds 9301, whose body fetch always fails: were its
 * headers cached, the save could never reach 0. The spec checks Flaky is not
 * in the count before relying on that.
 *
 * The unreachable-vault case renames the vault root away (the daemon's
 * reachability is `vault_root()` plus `is_dir()`, taken on every count),
 * reopens the panel so the row counts again, and puts the root back. It waits
 * for the search index to be idle first (the save's writes nudge it, and an
 * index pass creates its store under the root), and fails with its own
 * message if anything recreates the root while it is away. The
 * header cache lives inside the vault, and the daemon keeps it open, so the
 * count may come back with the reason or as unknown with the reason; both
 * must show the reason and neither may say everything is in the vault. It
 * runs last, and every spec file starts from a fresh data dir
 * (`resetAppState`), so a failed restore cannot reach another spec.
 *
 * Every wait is `browser.waitUntil(() => browser.execute(...))`: `$(sel)` and
 * `waitForDisplayed` die on tauri-wd, and a page callback cannot close over a
 * host variable, so everything it needs is passed as an argument.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './mockImap.js';
import { closeSettings, waitForApp, waitForEmails } from './helpers.js';
import { openTab } from './mockBilling.js';

const LUKE = 'luke@mock.test';
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

/** Vault files in the account's INBOX that carry the archived flag: `4:2,AS.eml` -> `AS`. */
function archivedInboxFiles(accountId) {
  const cur = join(vaultRoot(), accountId, 'INBOX', 'cur');
  if (!existsSync(cur)) return [];
  return readdirSync(cur).filter((name) => (name.split(/[:;]2,/)[1] || '').replace(/\.eml$/, '').includes('A'));
}

let away = null;

/** Put the vault root back where the daemon expects it. */
function restoreVault() {
  if (!away) return;
  const root = vaultRoot();
  // Something recreated the root while it was away: the renamed one is the vault.
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  renameSync(away, root);
  away = null;
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

    // Nothing but the save writes a body from here on.
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

    // The header cache may still be landing (INBOX pages, Sent for threading):
    // take the count once two reads a second apart agree and neither is a floor.
    let last = null;
    try {
      await browser.waitUntil(async () => {
        const reply = await daemonRpc('vault_gap_count', { accountId: lukeId });
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
    assert.ok((counted.byMailbox.find((f) => f.mailbox === 'INBOX')?.count || 0) > 0, 'luke\'s INBOX is not in the count');
    assert.equal(counted.byMailbox.some((f) => f.mailbox === 'Flaky'), false,
      'Flaky is counted: its 9301 never fetches, so Save them now could never reach 0');
    assert.equal(counted.byMailbox.reduce((n, f) => n + f.count, 0), counted.count);

    // The row counts when the panel opens: open it only now.
    await openTab('Backup & Restore', 'Backup Schedule');
  });

  after(async function () {
    // The vault first: a resumed pipeline writing into a missing root would recreate it.
    try { restoreVault(); } catch (e) { console.warn(`[vault-gap] could not put the vault back: ${e.message}`); }
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
    const inboxMissing = counted.byMailbox.find((f) => f.mailbox === 'INBOX').count;
    const before = archivedInboxFiles(lukeId).length;

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
    const gained = archivedInboxFiles(lukeId).length - before;
    assert.ok(gained >= inboxMissing, `INBOX gained ${gained} archived copies; ${inboxMissing} were missing`);
  });

  it('an unreachable vault shows the reason, never everything-in-your-vault, and cannot save', async function () {
    const root = vaultRoot();
    assert.ok(existsSync(root), `no vault at ${root}`);
    // The save's vault writes nudge the search index, and an index pass writes
    // (and creates) its store under the vault root. Rename only once the index
    // has been idle for two reads a second apart, so nothing recreates the root
    // while it is away.
    let index = null;
    let idleReads = 0;
    try {
      await browser.waitUntil(async () => {
        const reply = await daemonRpc('search_index_status', {});
        index = reply.ok ? reply.v : { error: reply.__error };
        const idle = reply.ok && !['indexing', 'starting'].includes(reply.v?.state);
        idleReads = idle ? idleReads + 1 : 0;
        return idleReads >= 2;
      }, { timeout: 120_000, interval: 1_000 });
    } catch (e) {
      throw new Error(`the search index never settled before the vault was moved away: ${JSON.stringify(index)} (${e.message})`);
    }
    away = `${root}.away-${Date.now()}`;
    renameSync(root, away);
    // Something writing into the vault while it is away brings the root back:
    // that is a failure of this setup, said as one, not a reachable vault.
    const recreated = () => (existsSync(root) ? readdirSync(root) : null);
    try {
      // Reopen the panel: the row counts again when it mounts. Through the
      // first sub-tab, which sends nothing on mount.
      await clickBackupSubTab('Backup & Restore');
      await wait(async () => (await gapRow(lukeId)) === null, 5_000, 'the Backup Schedule panel never closed');
      await clickBackupSubTab('Backup Schedule');

      let seen = null;
      let back = null;
      try {
        await wait(async () => {
          back = recreated();
          if (back) return true;
          seen = await gapRow(lukeId);
          return seen?.state === 'unreachable' || seen?.state === 'unknown';
        }, 30_000);
      } catch (e) {
        throw new Error(`the row never said the vault is unreachable: ${JSON.stringify(seen)} (${e.message})`);
      }
      assert.equal(back, null, `something recreated the vault root while it was away, holding ${JSON.stringify(back)}`);
      assert.ok(seen.text.includes(UNAVAILABLE), seen.text);
      assert.ok(!seen.text.includes(NONE), seen.text);
      assert.equal(seen.saveDisabled, true, 'Save them now is offered into a vault that is not there');

      const reply = await daemonRpc('vault_gap_count', { accountId: lukeId });
      assert.equal(recreated(), null, 'something recreated the vault root while it was away');
      assert.equal(reply.ok, true, `vault_gap_count refused: ${reply.__error}`);
      assert.equal(reply.v.vaultReachable, false);
      assert.equal(reply.v.reason, 'E_VAULT_UNAVAILABLE');
    } finally {
      restoreVault();
    }
  });
});
