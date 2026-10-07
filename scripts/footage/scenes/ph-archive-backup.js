/**
 * Product Hunt clip 2, c02-archive-backup-delete (Premium) - its own boot,
 * because it deletes a year from the mock server.
 *
 * Setup (not recorded): a folder in the run's HOME becomes the backup drive
 * (backup_save_external_location + backup_validate_external_location, the
 * route Settings > Backup takes after its folder picker), and the list shows
 * the Server source, whose header counts the server.
 *
 * The take: the Server list at rest; Select messages; the bulk dialog lists
 * the years; one year is picked; Next; Archive, Back up & Delete; Start; the
 * confirmation; confirm. The progress bubble runs Downloading, Verifying,
 * Backing up, Deleting and lands on "Operation Complete"; the Server count
 * drops; the Vault source then shows the year, now on disk and on the drive.
 *
 * FOOTAGE_ABD_YEAR (default: the oldest year the dialog offers). FOOTAGE_REFUSE_UID
 * (lib/mailbox.js) makes the server refuse one message's fetch, so the run really
 * keeps it on the server and says so.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, sampleLoad, pointer, OUT_DIR } from '../lib/footage.js';
import { L, SEL, probe, bootToInbox, resetView, beforeTake, waitPage, since, clickSel } from '../lib/scene.js';

const CLIP = 'c02-archive-backup-delete';
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const SELECT = `.mail-list-toolbar button[aria-label="${L('workspace.selectMessages')}"]`;
const COUNT = '[data-testid="email-list-count"]';

const bubbleText = () => {
  for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
    if (el.offsetHeight > 0) return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return '';
};
const countText = (s) => (document.querySelector(s)?.textContent || '').trim();
const rowStates = () => {
  const by = {};
  for (const el of document.querySelectorAll('[data-testid="email-row"] [data-testid="msg-state-icon"]')) {
    by[el.dataset.state] = (by[el.dataset.state] || 0) + 1;
  }
  return by;
};

/** The backup drive: a folder under the run's temp HOME, saved and write-tested like the picker does. */
async function seedBackupDrive(facts) {
  const dir = join(browser.footageDataDir, 'BackupDrive');
  mkdirSync(dir, { recursive: true });
  const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then((v) => done(v ?? true)).catch((e) => done({ __error: String(e?.message || e) }));
  }, cmd, args);
  const saved = await invoke('backup_save_external_location', { path: dir });
  console.log('[setup] backup location saved:', JSON.stringify(saved));
  if (saved?.__error) throw new Error(`backup_save_external_location: ${saved.__error}`);
  const valid = await invoke('backup_validate_external_location', {});
  console.log('[setup] backup location validated:', JSON.stringify(valid));
  if (valid?.__error || valid?.status !== 'ready') throw new Error(`backup location not ready: ${JSON.stringify(valid)}`);
  await browser.execute((loc) => window.__SETTINGS_STORE__.getState().setExternalBackupLocation(loc), valid);
  facts.backupLocation = valid;
}

describe('footage: ph-archive-backup', function () {
  this.timeout(1200000);
  const facts = {};

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    await seedBackupDrive(facts);
    await resetView();
    await clickSel(SEL.sourceServer);
    await waitPage(() => document.querySelectorAll('[data-testid="email-row"]').length > 5, { timeout: 15000 });
    await browser.pause(1500);
    facts.countBefore = await browser.execute(countText, COUNT);
    facts.rowsBefore = await browser.execute(rowStates);
    console.log(`[setup] server view: "${facts.countBefore}", rows ${JSON.stringify(facts.rowsBefore)}`);
  });

  after(function () {
    writeFileSync(join(OUT_DIR, `${CLIP}.facts.json`), JSON.stringify(facts, null, 2));
  });

  it(CLIP, async function () {
    await beforeTake(CLIP);
    const take = new Take(CLIP);
    await take.start();
    const load = sampleLoad(CLIP, 3);
    try {
      await take.hold(900);
      await take.click(SELECT, 'select-messages');
      await take.waitFor((t) => document.body.innerText.includes(t), 'bulk dialog', 10000, L('bulk.ops.bulkEmailOperations'));
      const reading = L('bulk.ops.readingAllEmails').split('{{')[0].trim();
      await take.waitFor((r) => !document.body.innerText.includes(r) && [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => /^\d{4} \(/.test((b.textContent || '').trim())).length >= 2, 'year buttons', 30000, reading);
      facts.years = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] button')]
        .map((b) => (b.textContent || '').trim()).filter((s) => /^\d{4} \(/.test(s)));
      const year = process.env.FOOTAGE_ABD_YEAR || facts.years.map((s) => s.slice(0, 4)).sort()[0];
      facts.year = year;
      await take.hold(1000);
      await take.click('[role="dialog"] button', `year-${year}`, { text: `${year} (` });
      const selectedWord = L('bulk.ops.emailsSelected').replace('{{selectedCount}}', '').trim();
      await take.waitFor((w) => document.body.innerText.includes(w), 'selection count', 10000, selectedWord);
      facts.selected = await browser.execute((w) => document.body.innerText.match(new RegExp(`([\\d,]+) ${w}`))?.[1], selectedWord);
      await take.hold(1000);
      await take.waitFor((n) => [...document.querySelectorAll('[role="dialog"] button')]
        .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), 'Next enabled', 15000, L('common.next'));
      await take.click('[role="dialog"] button', 'next', { text: L('common.next') });
      const ABD = '[data-testid="bulk-action-archive_backup_delete"]';
      await take.waitFor((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, 'ABD enabled', 8000, ABD);
      await take.hold(900);
      await take.click(ABD, 'archive-backup-delete');
      // The option's own line ("Copy into your vault and your backup drive, check both copies...").
      await take.hold(1700);
      await take.click('[data-testid="bulk-step2-confirm"]', 'start');
      await take.waitFor(() => !!document.querySelector('[data-testid="bulk-delete-confirm"]'), 'confirmation', 8000);
      facts.confirmText = await browser.execute(() => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 600));
      // Long enough to read the title, the lead and "Anything that fails to copy stays on the server."
      await take.hold(2600);
      await take.click('[data-testid="bulk-delete-confirm"]', 'confirm');
      const progress = [];
      const done = L('bulk.progress.operationComplete');
      const failed = L('bulk.progress.operationFailed');
      const deadline = Date.now() + 300000;
      let finished = false;
      while (Date.now() < deadline) {
        const text = await browser.execute(bubbleText);
        const t = take.t(Date.now());
        if (!progress.length || progress.at(-1).text !== text) progress.push({ t: Number(t.toFixed(3)), text });
        if (text.includes(done) || text.includes(failed)) { finished = text.includes(done); break; }
        await browser.pause(200);
      }
      facts.progress = progress;
      writeFileSync(join(OUT_DIR, `${CLIP}.progress.json`), JSON.stringify(progress, null, 2));
      if (!finished) throw new Error(`archive-backup-delete never completed: ${progress.at(-1)?.text}`);
      const first = progress.find((p) => /\d+%/.test(p.text));
      const last = progress.at(-1);
      facts.progressSeconds = first ? Number((last.t - first.t).toFixed(2)) : null;
      take.note('progress', { firstShown: first?.t ?? null, complete: last.t, seconds: facts.progressSeconds });
      console.log(`[footage] ${CLIP} progress visible for ${facts.progressSeconds} s, ${progress.length} distinct frames`);
      // The success state, and the Server count dropping under it.
      // FOOTAGE_REFUSE_UID: the run's own outcome line ("N removed from the server. 1 email was kept...").
      const removedWord = L('bulk.result.removedFromServer').replace('{{total}}', '').trim();
      if (process.env.FOOTAGE_REFUSE_UID) {
        await waitPage((w) => document.body.innerText.includes(w), { timeout: 8000, interval: 200 }, removedWord);
      }
      facts.outcome = await browser.execute((w) => {
        const hit = [...document.querySelectorAll('body *')].reverse()
          .find((el) => el.offsetHeight > 0 && el.children.length < 4 && (el.innerText || '').includes(w));
        return hit ? hit.innerText.replace(/\s+/g, ' ').trim() : null;
      }, removedWord);
      console.log(`[footage] outcome: ${facts.outcome}`);
      const before = facts.countBefore;
      const dropped = await waitPage((s, b) => {
        const c = (document.querySelector(s)?.textContent || '').trim();
        return !!c && c !== b;
      }, { timeout: 6000, interval: 200 }, COUNT, before);
      facts.countAfter = await browser.execute(countText, COUNT);
      facts.countDroppedAt = take.t(Date.now());
      console.log(`[footage] server count "${before}" -> "${facts.countAfter}" (${dropped ? 'changed' : 'UNCHANGED'})`);
      // Where the outcome line sits and whether it can be seen (run 2 found it in the DOM, not in the frames).
      facts.outcomeProbe = await browser.execute((w) => [...document.querySelectorAll('body *')]
        .filter((el) => el.children.length < 4 && (el.innerText || el.textContent || '').includes(w))
        .slice(-3).map((el) => {
          const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { tag: el.tagName, cls: String(el.className).slice(0, 120), role: el.getAttribute('role'),
            rect: [r.x, r.y, r.width, r.height].map(Math.round), opacity: cs.opacity, vis: cs.visibility,
            hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : null };
        }), removedWord);
      console.log(`[footage] outcome probe: ${JSON.stringify(facts.outcomeProbe)}`);
      const has = (sel) => browser.execute((x) => !!document.querySelector(x), sel);
      const kept = '[data-testid="email-row"] [data-testid="msg-state-icon"][data-state^="server"]';
      const gold = '[data-testid="email-row"] [data-testid="msg-state-icon"][data-state^="local-only"]';
      let shownKept = false;
      if (process.env.FOOTAGE_REFUSE_UID) {
        // The year again, from All mail: what left the server is in the vault and on
        // the drive, and the one message the server refused is still a server row.
        await take.hold(1000);
        await take.click(SEL.sourceAll, 'source-all');
        await browser.pause(700);
        await take.click(SEL.explorer, 'explorer-toggle');
        const yearSel = `[data-testid="explorer-group-row"][data-label="${facts.year}"] [data-testid="explorer-group-open"]`;
        if (await waitPage((x) => !!document.querySelector(x), { timeout: 8000 }, yearSel)) {
          await take.hold(1000);
          await take.click(yearSel, `explorer-${facts.year}`);
          await waitPage(() => document.querySelectorAll('.explorer-crumb').length >= 2, { timeout: 8000 });
          facts.months = await browser.execute(() => [...document.querySelectorAll('[data-testid="explorer-group-row"]')].map((r) => r.dataset.label));
          const month = (facts.months || []).find((m) => /december/i.test(m || '')) || (facts.months || [])[0];
          const monthSel = `[data-testid="explorer-group-row"][data-label="${month}"] [data-testid="explorer-group-open"]`;
          if (!month || !(await has(monthSel))) {
            facts.months = null;
            console.warn('[footage] no month row; falling back to the Vault view');
          } else {
          await take.hold(900);
          await take.click(monthSel, 'explorer-month');
          await waitPage(() => document.querySelectorAll('.explorer-crumb').length >= 3, { timeout: 8000 });
          await browser.pause(500);
          facts.monthRows = await browser.execute(rowStates);
          console.log(`[footage] explorer months ${JSON.stringify(facts.months)}, ${month} rows ${JSON.stringify(facts.monthRows)}`);
          if (await has(kept)) {
            await take.hover(kept, 'kept-row-icon');
            await take.hold(2800);
            shownKept = true;
          } else if (await has(gold)) {
            await take.hover(gold, 'gold-row-icon');
            await take.hold(2800);
          }
          await take.unhover();
          await take.hold(500);
          }
        } else {
          console.warn('[footage] explorer year row never showed; falling back to the Vault view');
        }
      }
      facts.shownKept = shownKept;
      if (!process.env.FOOTAGE_REFUSE_UID || !facts.months) {
        if (process.env.FOOTAGE_REFUSE_UID && await has('.explorer-crumb')) await take.click(SEL.list, 'list-toggle');
        await take.hold(dropped ? 2200 : 1200);
        await take.click(SEL.sourceVault, 'source-vault');
        await take.waitFor(() => document.querySelectorAll('[data-testid="email-row"]').length > 3, 'vault rows', 10000);
        await take.hold(1200);
        facts.vaultCount = await browser.execute(countText, COUNT);
        facts.vaultRows = await browser.execute(rowStates);
        console.log(`[footage] vault "${facts.vaultCount}", rows ${JSON.stringify(facts.vaultRows)}`);
        await take.hover('[data-testid="email-row"] [data-testid="msg-state-icon"]', 'vault-row-icon');
        await take.hold(3000);
        await take.unhover();
        await take.hold(600);
      }
      const rec = await take.stop();
      console.log(`[footage] ${CLIP}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
      if (rec.delivered < 10) throw new Error(`only ${rec.delivered} pictures delivered`);
    } catch (e) {
      facts.error = String(e?.message || e);
      await take.abort().catch(() => {});
      throw e;
    } finally {
      await load();
      await browser.pause(1500);
      facts.after = await probe();
      facts.bubbleAfter = await browser.execute(bubbleText);
    }
  });
});
