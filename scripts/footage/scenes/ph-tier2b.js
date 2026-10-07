/**
 * Product Hunt tour, Tier 2 batch B (docs/product-hunt-demo-script.md rows
 * 19-22), Dark Graphite: one app boot, one `it` (one .mov) per clip.
 *
 *   c19-unsubscribe        a newsletter, Unsubscribe in the reader, the email the list asks for, Send; Settings > Unsubscribe
 *   c20-email-cleanup      Settings > Email Cleanup: classified counts, categories, a per-message action, the Can Delete preview
 *   c21-scheduled-backups  Settings > Backup & Restore > Backup Schedule: on, daily / weekly / at set hours, the health check
 *   c22-export-image-html  a thread exported as one tall image, then as one HTML file
 *
 * Run env: FOOTAGE_EXTRA_MAIL=1 FOOTAGE_UNSUB_MAIL=1 (lib/mailbox.js; nine
 * subscription messages on top of the extra ten, so FOOTAGE_EXPECT_TOTAL is
 * 2861 with the default history), and MAILVAULT_SMTP_PLAINTEXT=1 (passed
 * through to the app: without it c19's Send fails against the plaintext mock
 * SMTP and its red toast sits in every later clip). `FOOTAGE_ONLY=c20-email-cleanup`
 * limits a run.
 *
 * Staged / disclosed:
 *  - c19: the four lists are invented and seeded with real List-Unsubscribe
 *    headers. The one pressed is the email-only list: the app opens a
 *    prefilled unsubscribe email and the mock SMTP server takes it. One-click
 *    lists are shown in Settings, never pressed (their POST would leave the
 *    mock for the internet, and a failed one opens the system browser).
 *  - c20: classification is run in `prepare` (the same `classification.run`
 *    the page sends on first open). One message's action is changed in the
 *    take (a stored correction); nothing is deleted or archived.
 *  - c21: the backup drive is a folder under the run's HOME, saved through the
 *    same commands as the folder picker; one real "Back up all accounts now"
 *    runs in `prepare` so the health check has external counts.
 *  - c22: the native save panel cannot be driven, so the destination comes
 *    from the VITE_E2E seam (`__MV_EXPORT_DEST__`); the files are really
 *    rendered and written, and copied into the run's output as evidence.
 */
import { mkdirSync, writeFileSync, existsSync, statSync, copyFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, clickSel, bootToInbox, resetView, beforeTake, waitPage, since,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const readerOpen = (empty) => !document.body.innerText.includes(empty);
const bodyHas = (s) => (document.body.innerText || '').includes(s);

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`. */
async function shoot(ctx, clip, body, { prepare } = {}) {
  if (!want(clip)) ctx.skip();
  await resetView();
  if (prepare) await prepare();
  await resetView();
  await beforeTake(clip);
  const take = new Take(clip);
  await take.start();
  try {
    await body(take);
    return await finish(take, clip);
  } catch (e) {
    facts[`${clip}Error`] = String(e?.message || e);
    await take.abort();
    throw e;
  }
}

/** One daemon RPC from the page (setup only): the channel the app's daemonCall uses. */
function rpc(method, params) {
  return browser.executeAsync((m, p, done) => {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) { done({ error: 'no invoke' }); return; }
    inv('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: v ?? null }), (e) => done({ error: String(e?.message || e) }));
  }, method, params);
}

/** A native <select> set the way React hears it; the cursor travels there first. */
async function setControl(take, selector, value, label) {
  if (take) await take.moveTo(selector, label);
  const r = await browser.execute((s, v) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.offsetHeight > 0);
    if (!el) return { error: `no visible ${s}` };
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value };
  }, selector, value);
  if (r.error) throw new Error(`${label}: ${r.error}`);
  if (take) take.note(`set-${label}`, { value, at: Number(take.t(Date.now()).toFixed(3)) });
  return r;
}

/** Tag the first visible element under `scope` matching `sel` whose trimmed text is exactly `text`. */
function markExact(scope, sel, text, tag) {
  return browser.execute((sc, s, tx, tg) => {
    document.querySelectorAll(`[data-footage-target="${tg}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const roots = sc ? [...document.querySelectorAll(sc)] : [document];
    for (const root of roots) {
      const hit = [...root.querySelectorAll(s)].find((el) => el.getClientRects().length > 0 && (el.innerText || el.textContent || '').trim() === tx);
      if (hit) { hit.setAttribute('data-footage-target', tg); return true; }
    }
    return false;
  }, scope, sel, text, tag);
}

/** The Settings search field takes focus on open; its ring is not part of the story. */
const blurActive = () => browser.execute(() => document.activeElement?.blur?.());

/** Settings > `navLabel` (> `tabLabel`), by real clicks; `ready` is the page predicate. */
async function toSettingsPage(take, navLabel, tabLabel, ready, what, ...args) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await blurActive();
  await take.hold(700);
  await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: navLabel, ms: 700 });
  await take.hold(250);
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav', { text: navLabel });
  if (tabLabel) {
    await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
      .some((b) => (b.innerText || '').trim() === t), `${what} tab`, 8000, tabLabel);
    await take.hold(600);
    await markExact('[data-testid="settings-page"]', '[role="tab"]', tabLabel, 'settings-tab');
    await take.click('[data-footage-target="settings-tab"]', 'tab');
  }
  await take.waitFor(ready, what, 30000, ...args);
  await blurActive();
}

/** Settings > nav (> tab) without recording (setup). */
async function settingsSetup(navLabel, tabLabel) {
  await clickSel('[data-testid="open-settings"]');
  await waitPage(settingsOpen, { timeout: 8000 });
  await clickSel('[data-testid="settings-page"] .settings-nav-item', navLabel);
  await browser.pause(800);
  if (tabLabel) {
    await markExact('[data-testid="settings-page"]', '[role="tab"]', tabLabel, 'settings-tab');
    await clickSel('[data-footage-target="settings-tab"]');
    await browser.pause(800);
  }
}

const workAccountId = () => browser.execute(() => window.__MAIL_STORE__?.getState?.().activeAccountId || null);

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 2 batch B', function () {
  this.timeout(3600000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accountId = await workAccountId();
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; account ${facts.accountId}; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(function () {
    writeFileSync(join(OUT_DIR, 'ph-tier2b.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 19. One-click Unsubscribe. The email-only list is the one pressed (see the header).
  it('c19-unsubscribe', async function () {
    const subject = 'Ink & Brine notes: autumn print run';
    const sender = 'Ink & Brine Press';
    const UNSUB_BTN = '[data-testid="sender-unsubscribe"]';
    const dialogs = '[role="alertdialog"], .mail-dialog';
    await shoot(this, 'c19-unsubscribe', async (take) => {
      await take.hold(1200);
      await take.reveal(SEL.row, 'newsletter-row', { text: subject, ms: 800 });
      await take.click(SEL.row, 'newsletter-row', { text: subject });
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'reader Unsubscribe', 15000, UNSUB_BTN);
      await take.hold(1600);
      await take.click(UNSUB_BTN, 'unsubscribe');
      await take.waitFor((d) => !!document.querySelector('[role="alertdialog"]')?.offsetHeight, 'confirm dialog', 8000);
      facts.c19Dialog = await browser.execute(() => (document.querySelector('[role="alertdialog"]')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(2200);
      if (!(await markExact(dialogs, 'button', L('unsubscribe.action'), 'unsub-confirm'))) throw new Error('no Unsubscribe button in the dialog');
      await take.click('[data-footage-target="unsub-confirm"]', 'confirm');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'prefilled compose', 15000, SEL.compose);
      facts.c19Compose = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 300), SEL.compose);
      await take.hold(1600);
      // The "Opened an unsubscribe email" toast sits where the undo-send toast
      // lands, and the two overlap (run 1); it is dismissed with its own X first.
      const dismiss = `button[aria-label="${L('toast.dismiss')}"]`;
      if (await browser.execute((s) => !!document.querySelector(s)?.offsetHeight, dismiss)) {
        await take.click(dismiss, 'dismiss-toast', { dur: 500 });
        await take.hold(500);
      }
      await take.click(SEL.send, 'send');
      await take.waitFor((s) => !document.querySelector(s)?.offsetHeight, 'compose closed', 10000, SEL.compose);
      await take.hold(1400);
      await toSettingsPage(take, L('unsubscribe.tabLabel'), null,
        () => document.querySelectorAll('[data-testid="unsubscribe-senders"] tbody tr').length >= 3
          && !!document.querySelector('[data-testid="unsubscribe-history"]'), 'unsubscribe page');
      facts.c19Senders = await browser.execute(() => [...document.querySelectorAll('[data-testid="unsubscribe-senders"] tbody tr')]
        .map((r) => r.innerText.replace(/\s+/g, ' ')));
      facts.c19History = await browser.execute(() => (document.querySelector('[data-testid="unsubscribe-history"]')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(4800);
    }, {
      prepare: async () => {
        facts.c19RowOnScreen = await browser.execute((s) => [...document.querySelectorAll('[data-testid="email-row"]')]
          .some((r) => (r.innerText || '').includes(s)), subject);
        if (!facts.c19RowOnScreen) throw new Error(`no "${subject}" row in the inbox`);
      },
    });
    // The send itself lands after the undo-send window (15 s); give it that, then read the outcome.
    await browser.pause(18000);
    facts.c19After = await probe();
    facts.c19HistoryRpc = await rpc('unsubscribe.history', { accountId: facts.accountId });
    facts.c19ToastsAfter = await browser.execute(() => [...document.querySelectorAll('[role="status"], [role="alert"], .fixed.bottom-6.right-4')]
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ')).filter(Boolean));
    facts.c19SendFailed = (facts.c19ToastsAfter || []).some((s) => /failed/i.test(s));
    if (facts.c19SendFailed) console.warn(`[c19] the unsubscribe email did NOT send: ${JSON.stringify(facts.c19ToastsAfter)}`);
    console.log(`[c19] ${sender}: compose "${facts.c19Compose}"; history ${JSON.stringify(facts.c19HistoryRpc).slice(0, 400)}; toasts ${JSON.stringify(facts.c19ToastsAfter)}`);
  });

  // 20. Email Cleanup (Premium): local classifier, categories, per-message action, preview counts.
  it('c20-email-cleanup', async function () {
    const page = '[data-testid="settings-content"][data-page="cleanup"]';
    const rowsReady = (p) => !!document.querySelector(`${p} input[type="checkbox"]`)
      && !!document.querySelector('[data-testid="cleanup-summary"]');
    await shoot(this, 'c20-email-cleanup', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.tab.cleanup'), null, rowsReady, 'cleanup results', page);
      facts.c20Summary = await browser.execute(() => (document.querySelector('[data-testid="cleanup-summary"]')?.innerText || '').replace(/\s+/g, ' '));
      facts.c20Tabs = await browser.execute((p) => [...document.querySelectorAll(`${p} button.rounded-full.border`)].map((b) => b.innerText.trim()), page);
      await take.hold(2600);
      // Category tabs only exist for categories with mail (run 1: no Newsletter,
      // no Work, no Spam on the demo mailbox). First a big one, then Promotional.
      const tabLabel = async (keys) => {
        for (const k of keys) {
          const w = `${L(`settings.cleanup.${k}`)} (`;
          if (await browser.execute((p, t) => [...document.querySelectorAll(`${p} button`)].some((b) => (b.innerText || '').trim().startsWith(t)), page, w)) return w;
        }
        return null;
      };
      const first = await tabLabel(['newsletter', 'transactional', 'work', 'notification']);
      if (first) {
        await take.click(`${page} button`, 'tab-first', { text: first });
        await take.hold(1800);
      }
      const promo = await tabLabel(['promotional', 'spam']);
      facts.c20TabsClicked = [first, promo];
      if (promo) {
        await take.click(`${page} button`, 'tab-promotional', { text: promo });
        await take.hold(1400);
      }
      // The first row's action pill (the second pill in the row), then a different action.
      const current = await browser.execute((p) => {
        document.querySelectorAll('[data-footage-target="action-pill"]').forEach((el) => el.removeAttribute('data-footage-target'));
        const row = [...document.querySelectorAll(`${p} div[role="button"]`)].find((r) => r.getClientRects().length > 0 && r.querySelectorAll('button.rounded-full').length >= 2);
        const pill = row?.querySelectorAll('button.rounded-full')[1];
        if (!pill) return null;
        pill.setAttribute('data-footage-target', 'action-pill');
        return pill.innerText.trim();
      }, page);
      if (!current) throw new Error('no action pill on the first cleanup row');
      const next = current === L('common.delete') ? L('common.archive') : L('common.delete');
      facts.c20ActionChange = { from: current, to: next };
      await take.click('[data-footage-target="action-pill"]', 'action-pill');
      await take.waitFor(() => !!document.querySelector('[role="menu"]')?.offsetHeight, 'action menu', 5000);
      await take.hold(1100);
      if (!(await markExact('[role="menu"]', '[role="menuitem"]', next, 'action-item'))) throw new Error(`no "${next}" in the action menu`);
      await take.click('[data-footage-target="action-item"]', 'action-item');
      await take.hold(1500);
      facts.c20SummaryAfterChange = await browser.execute(() => (document.querySelector('[data-testid="cleanup-summary"]')?.innerText || '').replace(/\s+/g, ' '));
      // The preview: everything the classifier would archive, selected; nothing is run.
      await take.click('[data-testid="cleanup-summary"] button', 'can-archive', { text: L('settings.cleanup.canArchive') });
      await take.waitFor((p) => [...document.querySelectorAll(`${p} button`)].some((b) => /^Delete \(\d+\)$/.test((b.innerText || '').trim())), 'delete preview', 5000, page);
      facts.c20Selection = await browser.execute((p) => [...document.querySelectorAll(`${p} button`)]
        .map((b) => (b.innerText || '').trim()).filter((s) => /^(Delete|Archive) \(\d+\)$/.test(s)), page);
      await take.hold(3000);
      await take.click(`${page} button`, 'deselect', { text: L('settings.cleanup.deselectAll') });
      await take.hold(1200);
    }, {
      prepare: async () => {
        const accountId = facts.accountId || await workAccountId();
        const t0 = Date.now();
        facts.c20Run = await rpc('classification.run', { accountId });
        let st = null;
        while (Date.now() - t0 < 300000) {
          await browser.pause(1500);
          st = (await rpc('classification.status', {})).ok;
          if (st && st.status !== 'Running' && Date.now() - t0 > 3000) break;
        }
        facts.c20Status = st;
        facts.c20Summary0 = (await rpc('classification.summary', { accountId })).ok ?? null;
        console.log(`[c20] classified in ${since(t0)} s: ${JSON.stringify(st)}`);
      },
    });
  });

  // 21. Scheduled backups + health (Premium).
  it('c21-scheduled-backups', async function () {
    const page = '[data-testid="settings-content"][data-page="backup"]';
    const SWITCH = `[role="switch"][aria-label="${L('settings.backup.schedule.automaticBackup')}"]`;
    const FREQ = `select[aria-label="${L('settings.backup.schedule.backupFrequency')}"]`;
    const ALL_BTN = '[data-testid="backup-all-button"]';
    const verify = L('settings.backup.account.verifyBackupCoverage');
    const tree = '[data-testid="backup-verification-tree"]';
    await shoot(this, 'c21-scheduled-backups', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.tab.backup'), L('settings.backup.backupSchedule'),
        (s) => !!document.querySelector(s), 'backup schedule', ALL_BTN);
      await take.hold(1500);
      await take.click(SWITCH, 'automatic-backup-on');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'frequency picker', 5000, FREQ);
      facts.c21FreqStart = await browser.execute((s) => document.querySelector(s)?.value, FREQ);
      await take.hold(1500);
      if (facts.c21FreqStart !== 'daily') { await setControl(take, FREQ, 'daily', 'freq-daily'); await take.hold(1000); }
      await setControl(take, FREQ, 'weekly', 'freq-weekly');
      await take.hold(1400);
      await setControl(take, FREQ, 'hours', 'freq-hours');
      await take.waitFor(() => !!document.querySelector('[data-testid="backup-hours-picker"]')?.offsetHeight, 'hours picker', 5000);
      await take.hold(900);
      const hour = (h) => `[data-testid="backup-hours-picker"] [data-hour="${h}"]`;
      if (await browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', hour(3))) {
        await take.click(hour(3), 'hour-03-off', { dur: 500 });
        await take.hold(300);
      }
      for (const h of [7, 12, 22]) {
        await take.click(hour(h), `hour-${h}`, { dur: 500 });
        await take.hold(350);
      }
      facts.c21Hours = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().backupGlobalConfig);
      await take.hold(1300);
      if (!(await markExact(page, 'button', verify, 'verify'))) throw new Error('no Verify backup coverage button');
      await take.reveal('[data-footage-target="verify"]', 'verify-reveal', { ms: 1200 });
      await take.hold(400);
      await take.click('[data-footage-target="verify"]', 'verify');
      await take.waitFor((s) => !!document.querySelector(`${s} table`), 'health tree', 30000, tree);
      await take.reveal(tree, 'tree-reveal', { ms: 900 });
      facts.c21Tree = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 800), tree);
      facts.c21Progress = await browser.execute(() => !!document.querySelector('[data-testid="backup-all-progress"]'));
      await take.hold(4200);
    }, {
      prepare: async () => {
        // The backup drive under the run's HOME, saved and write-tested like the picker does.
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
        facts.c21Location = valid;
        await browser.execute(() => window.__SETTINGS_STORE__.getState().setBackupGlobalEnabled?.(false));
        // One real backup of every account, so the drive holds mail.
        await settingsSetup(L('settings.tab.backup'), L('settings.backup.backupSchedule'));
        await waitPage((s) => !!document.querySelector(s), { timeout: 10000 }, ALL_BTN);
        const t0 = Date.now();
        await clickSel(ALL_BTN);
        await waitPage((s) => !!document.querySelector(s)?.disabled, { timeout: 15000, interval: 200 }, ALL_BTN);
        const done = await waitPage((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, { timeout: 900000, interval: 2000 }, ALL_BTN);
        facts.c21BackupSeconds = Number(since(t0));
        facts.c21BackupDone = done;
        console.log(`[c21] backup of all accounts ${done ? 'done' : 'NOT done'} in ${facts.c21BackupSeconds} s`);
        // A dry health check: are there external counts at all?
        if (await markExact(page, 'button', verify, 'verify')) {
          await clickSel('[data-footage-target="verify"]');
          await waitPage((s) => !!document.querySelector(`${s} table`), { timeout: 30000 }, tree);
          facts.c21TreeDry = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 800), tree);
          console.log(`[c21] dry health check: ${facts.c21TreeDry}`);
          await clickSel(`${tree} button`, L('settings.backup.verify.hide'));
          await browser.pause(500);
        }
        facts.c21DriveFiles = (() => { try { return readdirSync(dir).length; } catch { return null; } })();
      },
    });
  });

  // 22. Export a thread as an image, then as one HTML file (Premium).
  it('c22-export-image-html', async function () {
    const thread = 'launch campaign, round three';
    const exportDir = join(browser.footageDataDir, 'Exports');
    const pngPath = join(exportDir, 'rack-and-rind-round-three.png');
    const htmlPath = join(exportDir, 'rack-and-rind-round-three.html');
    const setDest = (p) => browser.execute((dest, dir) => { window.__MV_EXPORT_DEST__ = dest; window.__MV_EXPORT_DIR__ = dir; }, p, exportDir);
    const THREAD_EXPORT = `button[title="${L('email.thread.exportThread')}"]`;
    const dialogOpen = (t) => [...document.querySelectorAll('.mail-dialog')].some((d) => d.offsetHeight > 0 && (d.innerText || '').includes(t));
    const mirror = L('export.dialog.mirrorRemoteContent');
    const runExport = async (take, label) => {
      if (!(await markExact('.mail-dialog', 'button', L('common.export'), 'export-run'))) throw new Error('no Export button in the dialog');
      await take.click('[data-footage-target="export-run"]', label);
      const t0 = take.t(Date.now());
      take.cut(`${label}-busy-start`, 'Export button spinning while the file renders; trim to taste');
      await take.waitFor((m) => ![...document.querySelectorAll('.mail-dialog')].some((d) => d.offsetHeight > 0 && (d.innerText || '').includes(m)),
        `${label} done`, 60000, mirror);
      const t1 = take.t(Date.now());
      take.cut(`${label}-busy-end`, 'dialog closed: the file is written');
      facts[`c22${label}`] = { busyFrom: Number(t0.toFixed(2)), closedAt: Number(t1.toFixed(2)) };
    };
    await shoot(this, 'c22-export-image-html', async (take) => {
      await take.hold(1200);
      await take.reveal(SEL.row, 'thread-row', { text: thread, ms: 800 });
      await take.click(SEL.row, 'thread-row', { text: thread });
      await take.waitFor(readerOpen, 'thread to open', 10000, L('viewer.selectEmailRead'));
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'thread Export', 10000, THREAD_EXPORT);
      await take.hold(1800);
      // Image: one tall picture of the whole thread.
      await setDest(pngPath);
      await take.click(THREAD_EXPORT, 'export-thread');
      await take.waitFor(dialogOpen, 'export dialog', 8000, mirror);
      facts.c22Dialog = await browser.execute(() => ([...document.querySelectorAll('.mail-dialog')].find((d) => d.offsetHeight > 0)?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(1200);
      await take.click('.mail-dialog label:has(input[name="mv-export-format"][value="image"])', 'format-image');
      await take.hold(700);
      if (await browser.execute(() => !!document.querySelector('.mail-dialog input[name="mv-export-layout"][value="single"]'))) {
        await take.click('.mail-dialog label:has(input[name="mv-export-layout"][value="single"])', 'layout-single');
        await take.hold(900);
      }
      await runExport(take, 'export-image');
      facts.c22ImageNotice = await browser.execute(() => (document.querySelector('.mail-dialog .text-mail-danger')?.innerText || null));
      await take.hold(1300);
      // HTML: one self-contained file.
      await setDest(htmlPath);
      await take.click(THREAD_EXPORT, 'export-thread-again');
      await take.waitFor(dialogOpen, 'export dialog again', 8000, mirror);
      await take.hold(900);
      await take.click('.mail-dialog label:has(input[name="mv-export-format"][value="html"])', 'format-html');
      await take.hold(1300);
      await runExport(take, 'export-html');
      await take.hold(2200);
    }, {
      prepare: async () => {
        mkdirSync(exportDir, { recursive: true });
      },
    });
    await browser.execute(() => { delete window.__MV_EXPORT_DEST__; delete window.__MV_EXPORT_DIR__; });
    // Evidence: what was written, copied into the run's output (a subdir, not <clip>.* names).
    const evidence = join(OUT_DIR, 'c22-exports');
    mkdirSync(evidence, { recursive: true });
    facts.c22Files = readdirSync(exportDir).map((n) => {
      const p = join(exportDir, n);
      const size = statSync(p).size;
      try { copyFileSync(p, join(evidence, basename(n))); } catch { /* listed anyway */ }
      return { name: n, size };
    });
    facts.c22Png = existsSync(pngPath);
    facts.c22Html = existsSync(htmlPath);
    console.log(`[c22] exported: ${JSON.stringify(facts.c22Files)}`);
    if (!facts.c22Png || !facts.c22Html) throw new Error(`export files missing: png ${facts.c22Png}, html ${facts.c22Html}`);
  });
});
