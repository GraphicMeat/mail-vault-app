/**
 * How-to takes for the FAQ: the two ways to archive and delete from the
 * server, each with and without the backup drive. One boot, four takes, one
 * year each (the mock server loses that year, so they share a launch).
 *
 *   bulk-archive-delete            Select messages > year > Next > Archive & Delete > Start > confirm
 *   bulk-archive-backup-delete     the same with Archive, Back up & Delete
 *   settings-archive-delete        Settings > Backup & Restore > Archive & delete > Set up > summary > Start
 *   settings-archive-backup-delete the same on the backup card
 *
 * Each take writes <clip>.steps.json: named moments (seconds into the .mov)
 * the publisher decodes into the tutorial's step screenshots. Marks are taken
 * after the screen settles and before the next click, so a still shows the
 * state the step is about.
 *
 * Pair with FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 FOOTAGE_EXPECT_TOTAL=2842.
 * FOOTAGE_VERIFY=1 runs every step without a recorder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, sampleLoad, OUT_DIR } from '../lib/footage.js';
import { L, SEL, probe, bootToInbox, resetView, beforeTake, waitPage, since, clickSel, closeSettings } from '../lib/scene.js';

const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const SELECT = `.mail-list-toolbar button[aria-label="${L('workspace.selectMessages')}"]`;
const COUNT = '[data-testid="email-list-count"]';
const SETTINGS_NAV = L('settings.tab.backup');
const ABD_TAB = L('settings.backup.abd.tab');

// The bulk bubble lives in a toast dock (ToastDock.jsx), not a fixed corner div.
const bubbleText = () => {
  for (const el of document.querySelectorAll('[data-toast-dock]')) {
    if (el.offsetHeight > 0) return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return '';
};
const countText = (s) => (document.querySelector(s)?.textContent || '').trim();
const lastNumber = (txt) => Number(((txt || '').match(/\d[\d.,  ']*/g) || []).pop()?.replace(/\D/g, '') || NaN);

/** The backup drive: a folder under the run's temp HOME, saved and write-tested like the picker does. */
async function seedBackupDrive(facts) {
  const dir = join(browser.footageDataDir, 'BackupDrive');
  mkdirSync(dir, { recursive: true });
  const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then((v) => done(v ?? true)).catch((e) => done({ __error: String(e?.message || e) }));
  }, cmd, args);
  const saved = await invoke('backup_save_external_location', { path: dir });
  if (saved?.__error) throw new Error(`backup_save_external_location: ${saved.__error}`);
  const valid = await invoke('backup_validate_external_location', {});
  if (valid?.__error || valid?.status !== 'ready') throw new Error(`backup location not ready: ${JSON.stringify(valid)}`);
  await browser.execute((loc) => window.__SETTINGS_STORE__.getState().setExternalBackupLocation(loc), valid);
  facts.backupLocation = valid;
}

describe('footage: howto-abd', function () {
  this.timeout(2400000);
  const facts = { years: {}, used: [] };

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    await seedBackupDrive(facts);
  });

  after(function () {
    writeFileSync(join(OUT_DIR, 'howto-abd.facts.json'), JSON.stringify(facts, null, 2));
  });

  /** Reset to the Server list, off camera. */
  async function serverList() {
    await resetView();
    await clickSel(SEL.sourceServer);
    await waitPage(() => document.querySelectorAll('[data-testid="email-row"]').length > 5, { timeout: 15000 });
    await browser.pause(1500);
  }

  /** The take around one flow: recorder, step marks, steps.json, load sample. */
  async function record(clip, flow) {
    await beforeTake(clip);
    const take = new Take(clip);
    const steps = [];
    const mark = (id, caption) => {
      steps.push({ id, caption, t: Number(take.t(Date.now()).toFixed(3)) });
      console.log(`[step] ${clip} ${id} @${steps.at(-1).t}s`);
    };
    await take.start();
    const load = sampleLoad(clip, 3);
    try {
      await flow(take, mark);
      const rec = await take.stop();
      if (rec.delivered < 10) throw new Error(`only ${rec.delivered} pictures delivered`);
      writeFileSync(join(OUT_DIR, `${clip}.steps.json`), JSON.stringify({ clip, seconds: rec.seconds, steps }, null, 2));
    } catch (e) {
      facts[`${clip}Error`] = String(e?.message || e);
      await take.abort().catch(() => {});
      throw e;
    } finally {
      await load();
      await browser.pause(1500);
      facts[`${clip}After`] = await probe();
    }
  }

  /** The progress of the bulk bubble until it says complete; returns the distinct frames. */
  async function bulkProgress(take, mark) {
    const progress = [];
    const done = L('bulk.progress.operationComplete');
    const failed = L('bulk.progress.operationFailed');
    const deadline = Date.now() + 300000;
    let finished = false;
    let marked = false;
    while (Date.now() < deadline) {
      const text = await browser.execute(bubbleText);
      const t = take.t(Date.now());
      if (!progress.length || progress.at(-1).text !== text) progress.push({ t: Number(t.toFixed(3)), text });
      if (!marked && /\d+%/.test(text)) { marked = true; mark('progress', 'Progress runs in the corner of the window.'); }
      if (text.includes(done) || text.includes(failed)) { finished = text.includes(done); break; }
      await browser.pause(150);
    }
    if (!finished) throw new Error(`never completed: ${progress.at(-1)?.text}`);
    return progress;
  }

  /** After a run: the Vault shows the year and the Server count dropped by what was removed. */
  async function afterRun(take, mark, clip, countBefore, selected, { refresh = false } = {}) {
    const expected = lastNumber(countBefore) - Number(String(selected || '').replace(/\D/g, ''));
    const settle = async () => {
      const t0 = Date.now();
      let now = '';
      while (Date.now() - t0 < 60000) {
        now = await browser.execute(countText, COUNT);
        if (lastNumber(now) === expected) break;
        await browser.pause(80);
      }
      facts[`${clip}Counts`] = { before: countBefore, after: now, expected, settleSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
      if (lastNumber(now) !== expected) throw new Error(`${clip}: server count ${now}, expected ${expected} (before ${countBefore}, selected ${selected})`);
    };
    if (!refresh) {
      await settle();
      mark('done', 'Operation Complete, and the Server count drops.');
      await take.hold(1800);
    }
    await take.click(SEL.sourceVault, 'source-vault');
    await take.waitFor(() => document.querySelectorAll('[data-testid="email-row"]').length > 3, 'vault rows', 10000);
    await take.hold(900);
    facts[`${clip}Vault`] = await browser.execute(countText, COUNT);
    mark('vault', 'The Vault view still holds the archived emails.');
    await take.hold(1800);
    if (refresh) {
      // A Settings job frees the server in the background and the open list keeps its old count
      // (1,262 vs 1,162 in runs 1-3); opening the folder again lists the server afresh.
      await take.click(SEL.sourceServer, 'source-server');
      await take.hold(600);
      facts[`${clip}StaleCount`] = await browser.execute(countText, COUNT);
      await take.click('[data-testid="folder-row"][data-path="INBOX"]', 'open-inbox');
      await settle();
      await take.hold(900);
      mark('server-after', 'The Server view no longer lists them.');
      await take.hold(1500);
    }
  }

  /** Bulk flow: Select messages > a year > Next > the action > Start > confirm. */
  async function bulkFlow(clip, actionId) {
    await serverList();
    const countBefore = await browser.execute(countText, COUNT);
    await record(clip, async (take, mark) => {
      await take.hold(900);
      mark('server-list', 'Open the Server view of the account.');
      await take.click(SELECT, 'select-messages');
      await take.waitFor((t) => document.body.innerText.includes(t), 'bulk dialog', 10000, L('bulk.ops.bulkEmailOperations'));
      const reading = L('bulk.ops.readingAllEmails').split('{{')[0].trim();
      await take.waitFor((r) => !document.body.innerText.includes(r) && [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => /^\d{4} \(/.test((b.textContent || '').trim())).length >= 2, 'year buttons', 30000, reading);
      const years = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] button')]
        .map((b) => (b.textContent || '').trim()).filter((s) => /^\d{4} \(/.test(s)));
      const year = process.env.FOOTAGE_ABD_YEAR || years.map((s) => s.slice(0, 4)).sort().find((y) => !facts.used.includes(y));
      if (!year) throw new Error(`no unused year among ${JSON.stringify(years)}`);
      facts.used.push(year);
      facts.years[clip] = year;
      await take.hold(1200);
      mark('bulk-dialog', 'Bulk Email Operations lists the years.');
      await take.click('[role="dialog"] button', `year-${year}`, { text: `${year} (` });
      const selectedWord = L('bulk.ops.emailsSelected').replace('{{selectedCount}}', '').trim();
      await take.waitFor((w) => document.body.innerText.includes(w), 'selection count', 10000, selectedWord);
      const selected = await browser.execute((w) => document.body.innerText.match(new RegExp(`([\\d,.\\u00a0\\u202f']+) ${w}`))?.[1], selectedWord);
      facts[`${clip}Selected`] = selected;
      await take.hold(1100);
      mark('year-picked', 'Pick a year and see how many emails it selects.');
      await take.waitFor((n) => [...document.querySelectorAll('[role="dialog"] button')]
        .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), 'Next enabled', 15000, L('common.next'));
      await take.click('[role="dialog"] button', 'next', { text: L('common.next') });
      const ACTION = `[data-testid="bulk-action-${actionId}"]`;
      await take.waitFor((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, 'action enabled', 8000, ACTION);
      await take.hold(1100);
      mark('choose-action', 'Choose the action.');
      await take.click(ACTION, actionId);
      await take.hold(1700);
      mark('action-chosen', 'The option explains what it will do before you start.');
      await take.click('[data-testid="bulk-step2-confirm"]', 'start');
      await take.waitFor(() => !!document.querySelector('[data-testid="bulk-delete-confirm"]'), 'confirmation', 8000);
      await take.hold(2400);
      mark('confirm', 'Read the confirmation, then confirm.');
      await take.click('[data-testid="bulk-delete-confirm"]', 'confirm');
      facts[`${clip}Progress`] = await bulkProgress(take, mark);
      await afterRun(take, mark, clip, countBefore, selected);
    });
  }

  /** Settings flow: Backup & Restore > Archive & delete > Set up > scope > summary > Start. */
  async function settingsFlow(clip, setupTestId) {
    await serverList();
    const countBefore = await browser.execute(countText, COUNT);
    await record(clip, async (take, mark) => {
      await take.hold(900);
      await take.click('[data-testid="open-settings"]', 'open-settings');
      await take.waitFor(() => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings', 8000);
      await take.hold(700);
      mark('settings', 'Open Settings.');
      await take.click('[data-testid="settings-page"] .settings-nav-item', 'backup-restore', { text: SETTINGS_NAV });
      await take.hold(700);
      await take.click('[data-testid="settings-page"] [role="tab"]', 'abd-tab', { text: ABD_TAB });
      await take.waitFor(() => !!document.querySelector('[data-testid="abd-section"]'), 'abd section', 8000);
      await take.hold(1300);
      mark('abd-section', 'Archive & delete holds both jobs.');
      await take.click(`[data-testid="${setupTestId}"]`, 'set-up');
      await take.waitFor(() => !!document.querySelector('[data-testid="abd-folders"]'), 'folders listed', 120000);
      await take.hold(1200);
      mark('setup-folders', 'Tick the folders to clear.');
      const choose = L('settings.backup.abd.setup.datesChoose');
      await take.click('[data-testid="abd-setup"] [role="radio"]', 'choose-years', { text: choose });
      await take.waitFor(() => document.querySelectorAll('[data-testid^="abd-year-"]').length >= 2, 'years', 15000);
      const years = await browser.execute(() => [...document.querySelectorAll('[data-testid^="abd-year-"]')].map((e) => e.dataset.testid.slice(9)));
      const year = process.env.FOOTAGE_ABD_YEAR || years.slice().sort().find((y) => !facts.used.includes(y));
      if (!year) throw new Error(`no unused year among ${JSON.stringify(years)}`);
      facts.used.push(year);
      facts.years[clip] = year;
      await take.click(`[data-testid="abd-year-${year}"]`, `year-${year}`);
      await take.hold(1200);
      mark('setup-dates', 'Choose the years.');
      await take.reveal('[data-testid="abd-when-after-all"]', 'when-to-delete');
      await take.hold(900);
      await take.click('[data-testid="abd-how-trash"]', 'how-trash');
      await take.hold(1400);
      mark('setup-delete-options', 'Choose when and how to delete.');
      await take.reveal('[data-testid="abd-start"]', 'summary');
      await take.waitFor(() => !document.querySelector('[data-testid="abd-summary"]')?.dataset.stale, 'summary fresh', 20000);
      await take.hold(1800);
      const summary = await browser.execute(() => (document.querySelector('[data-testid="abd-summary"]')?.innerText || '').replace(/\s+/g, ' '));
      facts[`${clip}Summary`] = summary;
      const selected = await browser.execute(() => (document.querySelector('[data-testid="abd-summary-total"]')?.innerText || '').match(/(\d[\d.,\u00a0\u202f']*)/)?.[1]);
      facts[`${clip}Selected`] = selected;
      mark('setup-summary', 'The summary shows what will be removed.');
      await take.click('[data-testid="abd-confirm"]', 'confirm');
      await take.hold(900);
      mark('setup-confirm', 'Tick the confirmation and Start.');
      await take.click('[data-testid="abd-start"]', 'start');
      // The job runs in the background: the section says so, then Settings closes on the main window's panel.
      await take.waitFor(() => !!document.querySelector('[data-testid="abd-job-line"]'), 'job line', 30000);
      await take.hold(1400);
      mark('job-running', 'The job starts and runs in the background.');
      await closeSettings();
      await take.waitFor(() => !!document.querySelector('[data-testid="abd-panel"]')?.offsetHeight, 'panel', 15000);
      await take.hold(1200);
      mark('progress', 'The progress panel follows the job.');
      const deadline = Date.now() + 300000;
      let state = '';
      while (Date.now() < deadline) {
        state = await browser.execute(() => document.querySelector('[data-testid="abd-status"]')?.dataset.state || '');
        if (state === 'completed' || state === 'failed' || state === 'cancelled') break;
        await browser.pause(200);
      }
      if (state !== 'completed') throw new Error(`${clip}: job ended ${state || 'never'}`);
      await take.hold(900);
      mark('job-complete', 'The job finishes.');
      await take.hold(1200);
      await take.click('[data-testid="abd-done"]', 'close-panel');
      await take.hold(700);
      await afterRun(take, mark, clip, countBefore, selected, { refresh: true });
    });
  }

  it('bulk-archive-delete', () => bulkFlow('bulk-archive-delete', 'archive_and_delete'));
  it('bulk-archive-backup-delete', () => bulkFlow('bulk-archive-backup-delete', 'archive_backup_delete'));
  it('settings-archive-delete', () => settingsFlow('settings-archive-delete', 'abd-setup-archive'));
  it('settings-archive-backup-delete', () => settingsFlow('settings-archive-backup-delete', 'abd-setup-backup'));
});
