/**
 * E2E: "Back up now" and "Back up all accounts now" run, in the compiled app.
 *
 * Nightly 8e5f6af, 2026-09-12: after a restart the user was idle three minutes,
 * the schedule queued thirteen accounts, and every automatic run was cancelled
 * the moment the user touched the app. The coordinator sat in PAUSED_USER_ACTIVE
 * and for three hours "Back up now" only spun while "Back up all accounts now"
 * did nothing at all. Three separate defects, each one enough on its own:
 *
 *   - a click went through queueBackup, which returns early for an id already
 *     queued, so its promise never resolved and the spinner never stopped;
 *   - "Back up all" pushed its manual ids to the BACK of the queue, and the
 *     loop only ever looked at the head, which was automatic and gated;
 *   - tick(), the one thing that could have restarted the loop, refused to
 *     touch a paused queue at all.
 *
 * The unit specs cover the coordinator. This covers the thing the user does:
 * the state that used to freeze is seeded, the real button is clicked, and the
 * assertions are the run's files on disk and the card's own controls.
 *
 * Every wait is `browser.waitUntil(() => browser.execute(...))`. `$(sel)` and
 * `waitForDisplayed` die on tauri-wd, and a page callback cannot close over a
 * host variable - everything it needs is passed as an argument.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';

const wait = (predicate, timeout, message) =>
  browser.waitUntil(predicate, { timeout, interval: 200, timeoutMsg: message });

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
  }, cmd, args);
}

/**
 * Click a backup sub-tab. "Backup & Restore" names both the sidebar tab and the
 * first sub-tab, and the sub-tab bar renders after the sidebar - so the last
 * match is the sub-tab, the first would be the sidebar entry.
 */
async function clickBackupSubTab(label) {
  const clicked = await browser.execute((wanted) => {
    const matches = [...document.querySelectorAll('button')]
      .filter((b) => b.offsetHeight > 0 && b.textContent.trim() === wanted);
    if (!matches.length) return false;
    matches[matches.length - 1].click();
    return true;
  }, label);
  await browser.pause(400);
  return clicked;
}

/** The "Back up now" control on one account's card, as the DOM reports it. */
const cardButton = (accountId) => browser.execute((id) => {
  const button = document.querySelector(
    `[data-testid="backup-account-card"][data-account-id="${id}"] [data-testid="backup-now-button"]`);
  if (!button) return null;
  const card = button.closest('[data-testid="backup-account-card"]');
  const block = card.querySelector('[data-testid="backup-card-progress"]');
  return {
    label: button.textContent.trim(),
    disabled: button.disabled,
    progress: !!block,
    bar: !!(block && block.querySelector('[data-testid="backup-card-bar"]')),
  };
}, accountId);

const allButton = () => browser.execute(() => {
  const button = document.querySelector('[data-testid="backup-all-button"]');
  if (!button) return null;
  const panel = document.querySelector('[data-testid="backup-all-progress"]');
  return {
    label: button.textContent.trim(),
    disabled: button.disabled,
    progress: !!panel,
    bar: !!(panel && panel.querySelector('[data-testid="backup-all-bar"]')),
  };
});

const queueState = () => browser.execute(() => {
  const s = window.__BACKUP_SCHEDULER__;
  return { queue: [...s._queue], state: s.state, running: s._queueRunning };
});

/**
 * Put the coordinator back where the next case expects it.
 *
 * `_showNextOrDone` is the only route to the store's activeBackup from here, and
 * it has to run: an empty queue is not enough, because a run that ends with work
 * still queued parks activeBackup on the next id and nothing else clears it.
 */
async function resetCoordinator() {
  await browser.execute(() => {
    const s = window.__BACKUP_SCHEDULER__;
    s._state = 'idle';
    s._queue = [];
    s._manualIds.clear();
    s._publishQueue();
    s._showNextOrDone();
  });
  await wait(async () => !(await allButton()).progress, 15_000, 'The Back up all panel never cleared');
}

const lastStatus = (accountId) => browser.execute((id) =>
  window.__SETTINGS_STORE__.getState().backupState?.[id]?.lastStatus || null, accountId);

/** Message files the mirror holds for one account's INBOX. */
function mirrorFiles(root, email) {
  const cur = join(root, email, 'INBOX', 'cur');
  return existsSync(cur) ? readdirSync(cur) : [];
}

describe('Backup - a manual run jumps the queue and finishes, in the app', function () {
  this.timeout(300_000);

  let lukeId = null;
  let vaderId = null;
  let mirrorRoot = null;

  before(async function () {
    assert.equal(await waitForApp(), 'ready');
    await waitForEmails();
    await wait(() => browser.execute(() => !!window.__BACKUP_SCHEDULER__ && !!window.__SETTINGS_STORE__),
      20_000, 'The build must enable VITE_E2E');

    lukeId = browser.mockAccounts.find((a) => a.email === LUKE).id;
    vaderId = browser.mockAccounts.find((a) => a.email === VADER).id;

    // This spec's own mirror. connected-backup-orphan-restore points the app at
    // a temp dir it then deletes, so inheriting whatever location is stored
    // would test that spec's teardown instead of this one's subject.
    mirrorRoot = mkdtempSync(join(tmpdir(), 'mv-manual-queue-mirror-'));
    const saved = await invoke('backup_save_external_location', { path: mirrorRoot });
    assert.equal(saved?.__error, undefined, `backup_save_external_location threw: ${saved?.__error}`);

    // Premium, with every schedule off: the card renders its real controls
    // instead of the paywall blur, and checkAndQueueDue still has nothing it is
    // allowed to queue, so the only ids in the queue are the ones a case puts
    // there. Snapshots and notifications off - neither is this spec's subject.
    await browser.execute(() => {
      window.__SETTINGS_STORE__.setState({
        language: 'en',
        billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true },
        backupGlobalEnabled: false,
        backupSchedules: {},
        hiddenAccounts: {},
        snapshotAutoEnabled: false,
        backupNotifyOnSuccess: false,
        backupNotifyOnFailure: false,
      });
    });

    await openSettings();
    assert.equal(await clickSettingsNav('Backup & Restore'), true);
    assert.equal(await clickBackupSubTab('Backup Schedule'), true);
    await wait(async () => (await allButton()) !== null, 15_000, 'The Backup Schedule sub-tab never rendered');
    await wait(async () => (await cardButton(lukeId)) !== null && (await cardButton(vaderId)) !== null,
      15_000, 'Both account cards must render their own Back up now control');
  });

  after(async function () {
    await invoke('backup_clear_external_location', {});
    if (mirrorRoot) rmSync(mirrorRoot, { recursive: true, force: true });
    await closeSettings();
  });

  it('has no user-activity pause left to fall into', async function () {
    const contract = await browser.execute(() => {
      const s = window.__BACKUP_SCHEDULER__;
      const gone = typeof s.onUserActive === 'undefined' && typeof s.onUserIdle === 'undefined';
      // The state itself is gone, so even a coordinator somehow holding the old
      // string is not paused by it - nothing can strand the queue there again.
      s._state = 'paused_user_active';
      const paused = s._isPaused();
      s._state = 'idle';
      return { gone, paused };
    });

    assert.equal(contract.gone, true, 'onUserActive / onUserIdle are back - user activity can cancel a run again');
    assert.equal(contract.paused, false, 'paused_user_active still gates the queue');
    await resetCoordinator();
  });

  it('runs a click on one account past a sleep pause holding another account', async function () {
    // The 2026-09-12 shape: the coordinator is paused, somebody else's id is
    // parked in the queue, and the user clicks Back up now.
    await browser.execute((id) => {
      const s = window.__BACKUP_SCHEDULER__;
      s._state = 'paused_sleep';
      s._queue = [id];
      s._publishQueue();
    }, vaderId);

    await wait(async () => {
      const vader = await cardButton(vaderId);
      return !!vader && vader.disabled && vader.label.includes('Queued...');
    }, 15_000, 'The parked account never said Queued...');

    assert.equal(await browser.execute((id) => {
      const button = document.querySelector(
        `[data-testid="backup-account-card"][data-account-id="${id}"] [data-testid="backup-now-button"]`);
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      button.click();
      return true;
    }, lukeId), true, 'Luke\'s Back up now was missing or disabled while only Vader was queued');

    await wait(async () => {
      const luke = await cardButton(lukeId);
      return !!luke && luke.progress && luke.bar;
    }, 15_000, 'The clicked card never showed a progress bar - this is the three-hour spinner');

    await wait(async () => !(await cardButton(lukeId)).disabled, 180_000, 'The clicked run never finished');

    assert.ok(['success', 'degraded'].includes(await lastStatus(lukeId)),
      `Luke's run did not record a completed status (got ${await lastStatus(lukeId)})`);
    assert.ok(mirrorFiles(mirrorRoot, LUKE).length > 0, 'The run wrote nothing to the external mirror');

    const after = await queueState();
    assert.deepEqual(after.queue, [vaderId], 'The parked automatic id must survive the manual run, in place');
    assert.equal(after.state, 'paused_sleep', 'The pause the manual run borrowed must be handed back');

    await resetCoordinator();
  });

  it('runs an account the schedule had already queued', async function () {
    // A queued card is deliberately not clickable - it already has a place in
    // line. This is the same id reaching triggerManualBackup the way "Back up
    // all" reaches it, which is the call that used to return early and resolve
    // nothing because the id was already in the queue.
    await browser.execute((id) => {
      const s = window.__BACKUP_SCHEDULER__;
      s._state = 'paused_sleep';
      s._queue = [id];
      s._publishQueue();
    }, lukeId);

    await wait(async () => {
      const luke = await cardButton(lukeId);
      return !!luke && luke.disabled && luke.label.includes('Queued...');
    }, 15_000, 'The queued card never said Queued...');

    await browser.execute((id) => { window.__BACKUP_SCHEDULER__.triggerManualBackup(id); }, lukeId);

    await wait(async () => {
      const luke = await cardButton(lukeId);
      return !!luke && luke.progress && luke.bar;
    }, 15_000, 'An id already in the queue never started when it was triggered manually');

    await wait(async () => !(await cardButton(lukeId)).disabled, 180_000, 'The re-triggered run never finished');
    assert.deepEqual((await queueState()).queue, [], 'The id must leave the queue, not be run twice');

    await resetCoordinator();
  });

  it('backs up every account from one button, and user activity does not stop it', async function () {
    const before = { [LUKE]: mirrorFiles(mirrorRoot, LUKE).length, [VADER]: mirrorFiles(mirrorRoot, VADER).length };

    assert.equal(await browser.execute(() => {
      const button = document.querySelector('[data-testid="backup-all-button"]');
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      button.click();
      return true;
    }), true, 'Back up all accounts now was missing or already disabled');

    await wait(async () => {
      const all = await allButton();
      return !!all && all.progress && all.bar;
    }, 3_000, 'Back up all showed no progress panel - this is the button that did nothing for three hours');

    await wait(async () => {
      const cards = await Promise.all([cardButton(lukeId), cardButton(vaderId)]);
      return cards.some((c) => c && (c.progress || c.label.includes('Queued...')));
    }, 3_000, 'No account card owned up to the work Back up all had just queued');

    // The activity that used to cancel the run. `useBackupScheduler` still
    // listens to all of it - it just no longer has a pause to put the
    // coordinator into.
    for (let i = 0; i < 5; i++) {
      await browser.execute(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        const page = document.querySelector('[data-testid="settings-page"]');
        if (page) page.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await browser.pause(700);
    }

    await wait(async () => {
      const all = await allButton();
      return !!all && !all.disabled && (await queueState()).queue.length === 0;
    }, 240_000, 'Back up all never finished - the queue still holds work nobody is draining');

    for (const [id, email] of [[lukeId, LUKE], [vaderId, VADER]]) {
      assert.ok(['success', 'degraded'].includes(await lastStatus(id)),
        `${email} did not record a completed status (got ${await lastStatus(id)})`);
      assert.ok(mirrorFiles(mirrorRoot, email).length >= before[email] && mirrorFiles(mirrorRoot, email).length > 0,
        `${email} has no messages in the external mirror`);
    }

    assert.equal(await browser.execute(() => document.body.innerText.includes('Cancelled')), false,
      'Something was cancelled - user activity is stopping backups again');

    await resetCoordinator();
  });
});
