/**
 * Product Hunt tour, Tier 2 batch E (docs/product-hunt-demo-script.md rows
 * 31 and 33), dark: one app boot, one `it` (one .mov) per clip.
 *
 *   c31-download-modes        (Premium) Settings > Storage > Download mode: On Demand, Keep Recent and its
 *                             window (3 mo, 6 mo, 1 year), Index Only, Hoarder; then the local storage usage row
 *   c33-mbox-takeout-import   Settings > Backup & Restore > Import MBOX: a Google Takeout file, the options
 *                             dialog (the three modes, "Use Gmail labels"), "Import as a separate folder",
 *                             Import, the progress chip, the new folder under "On this computer" with its rows
 *
 * Staged, and only this: the native open panel is skipped through the
 * VITE_E2E seam `window.__MV_MBOX_SOURCE__` (src/services/mboxUpload.js
 * pickMboxFile), pointing at an invented Takeout file this spec writes into the
 * run's data dir (HOME); the import's result `alert()` is captured instead of
 * drawn (a native alert blocks WebDriver), so it never shows on screen. The
 * daemon really reads, files and lists the file. The harness runs with
 * MAILVAULT_DISABLE_HOARDER and MAILVAULT_DISABLE_EVICTION, so c31's mode
 * clicks start no download and remove nothing; both settings are put back
 * after the take. Premium is the harness seed (the Hoarder "Premium" tag only
 * draws for free users).
 *
 * `FOOTAGE_ONLY=c31-download-modes` limits a run.
 *
 * Helpers are copied from ph-tier2d.js on purpose: importing a spec would
 * register its clips in this run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake,
  waitPage, since, setSetting,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

// ── Take plumbing (from ph-tier2d.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`. */
async function shoot(ctx, clip, body, { prepare, after } = {}) {
  if (!want(clip)) ctx.skip();
  await resetView();
  if (prepare) await prepare();
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
  } finally {
    if (after) { try { await after(); } catch (e2) { facts[`${clip}After`] = String(e2?.message || e2); } }
  }
}

/** Tag the first visible `selector` whose text contains `needle`, for a Take to click by selector. */
function tagFirst(selector, needle, tag) {
  return browser.execute((s, n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(s)]
      .find((el) => el.getBoundingClientRect().height > 0 && (!n || (el.innerText || '').includes(n)));
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, selector, needle, tag);
}

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const visible = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0);

/** Settings > `navLabel` (> `tabLabel`), by real clicks; the search field's focus ring blurred. */
async function toSettingsPage(take, navLabel, tabLabel, ready, what, ...args) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await browser.execute(() => document.activeElement?.blur?.());
  await take.hold(600);
  await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: navLabel, ms: 600 });
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav', { text: navLabel });
  if (tabLabel) {
    await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
      .some((b) => (b.innerText || '').trim() === t), `${what} tab`, 8000, tabLabel);
    await take.hold(500);
    await take.click('[data-testid="settings-page"] [role="tab"]', 'tab', { text: tabLabel });
  }
  await take.waitFor(ready, what, 15000, ...args);
  await browser.execute(() => document.activeElement?.blur?.());
}

async function closeSettingsByClick(take) {
  const sel = await browser.execute((c) => {
    for (const s of [`[data-testid="settings-page"] button[aria-label="${c}"]`, `[data-testid="settings-page"] button[title="${c}"]`]) {
      if ([...document.querySelectorAll(s)].some((b) => b.offsetHeight > 0)) return s;
    }
    return null;
  }, L('common.close'));
  if (sel) await take.click(sel, 'settings-close');
  else {
    take.cut('settings-close', 'settings closed with Escape');
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings to close', 6000);
}

/** Whether the element matching `s` is what a pointer at its centre would hit (not covered). */
const onTop = (s) => {
  const el = document.querySelector(s);
  if (!el || !el.offsetHeight) return null;
  const b = el.getBoundingClientRect();
  const top = document.elementFromPoint(b.x + b.width / 2, b.y + Math.min(20, b.height / 2));
  return !!top && el.contains(top);
};

// ── The Takeout file (invented, no real data) ───────────────────────────────

// Rowan's old personal Gmail, 2015 to 2018, labelled like a Takeout export.
// Labels name the work account's real folders (Inbox, Clients, Suppliers) plus
// Gmail system labels, so the probe offers "Use Gmail labels".
const TAKEOUT = [
  ['2015-03-04T09:12:00Z', 'Maren Holt <maren@saltcellar.co>', 'Salt Cellar menu boards, first sketches', 'Inbox,Clients,Opened', 'Three directions for the chalk boards attached. The hand-lettered one is my favourite.'],
  ['2015-04-17T14:40:00Z', 'Otto Brandt <otto@brandtpaper.de>', 'Paper samples for the Salt Cellar menus', 'Inbox,Suppliers,Opened', 'Samples of the 350 gsm cotton stock are in the post. Let me know which white works.'],
  ['2015-06-02T11:05:00Z', 'Maren Holt <maren@saltcellar.co>', 'Re: Salt Cellar menu boards, first sketches', 'Inbox,Clients,Starred,Opened', 'We love the lettered one. Can we see it with the autumn dishes?'],
  ['2015-09-21T16:30:00Z', 'Juno Park <juno@parkandflame.kr>', 'Park & Flame opening night invitation', 'Inbox,Clients,Opened', 'Proofs for the invitation are ready. Gold foil or blind emboss?'],
  ['2015-11-09T08:55:00Z', 'Inkwell Press <orders@inkwellpress.co>', 'Order 4471 shipped: 500 letterpress cards', 'Inbox,Suppliers,Opened', 'Your order has shipped and should arrive in three working days.'],
  ['2016-01-14T10:20:00Z', 'Tomas Reyes <tomas@harborsmoke.com>', 'Harbor Smoke rebrand kickoff', 'Inbox,Clients,Starred,Opened', 'Thursday at ten works. Bring the old signage photos if you still have them.'],
  ['2016-02-26T13:15:00Z', 'Tomas Reyes <tomas@harborsmoke.com>', 'Harbor Smoke logo, round two notes', 'Inbox,Clients,Opened', 'The anchor reads better smaller. Can we try it without the rope?'],
  ['2016-04-08T17:45:00Z', 'Linnea Berg <linnea@bergtype.se>', 'Licence for Kiln Serif, two seats', 'Inbox,Suppliers,Opened', 'Licence attached for two desktop seats. Invoice to follow.'],
  ['2016-06-19T09:00:00Z', 'Maren Holt <maren@saltcellar.co>', 'Summer menu, one more dish', 'Inbox,Clients,Opened', 'Chef added a grilled peach salad. Can we squeeze it onto the board?'],
  ['2016-08-30T15:25:00Z', 'Ada Novak <ada@novakphoto.co>', 'Food shoot at Park & Flame, contact sheets', 'Inbox,Clients,Opened', 'Contact sheets from Saturday are in the shared folder. Frame 14 is the one.'],
  ['2016-10-12T12:10:00Z', 'Otto Brandt <otto@brandtpaper.de>', 'Price change for cotton stock from January', 'Inbox,Suppliers,Opened', 'A small change to the cotton stock price from January. Old orders keep the old price.'],
  ['2016-12-05T18:35:00Z', 'Juno Park <juno@parkandflame.kr>', 'Holiday cards, final approval', 'Inbox,Clients,Starred,Opened', 'Approved. Please print 300 and ship them to the restaurant.'],
  ['2017-02-03T11:50:00Z', 'Tomas Reyes <tomas@harborsmoke.com>', 'Harbor Smoke signage installed', 'Inbox,Clients,Opened', 'The sign went up this morning. Photos attached, it looks great at night.'],
  ['2017-03-22T09:30:00Z', 'Inkwell Press <orders@inkwellpress.co>', 'Order 5108 shipped: 300 holiday cards', 'Inbox,Suppliers,Opened', 'Your order has shipped. Tracking number in your account.'],
  ['2017-05-16T14:05:00Z', 'Priya Raines <priya@tenderloin.type>', 'Brisket Sans beta, want to try it?', 'Inbox,Suppliers,Opened', 'We are testing a new grotesque and thought of your menus. Beta files attached.'],
  ['2017-07-07T10:45:00Z', 'Ada Novak <ada@novakphoto.co>', 'Invoice for the Park & Flame shoot', 'Inbox,Clients,Opened', 'Invoice attached, thirty days as usual. Thanks for the referral.'],
  ['2017-09-28T16:20:00Z', 'Maren Holt <maren@saltcellar.co>', 'Salt Cellar turns three', 'Inbox,Clients,Starred,Opened', 'We are throwing a small party on the 12th. You have to come.'],
  ['2017-11-13T08:40:00Z', 'Linnea Berg <linnea@bergtype.se>', 'Kiln Serif 2.0 is out', 'Inbox,Suppliers,Opened', 'Version 2.0 adds small caps and old style figures. Your licence covers it.'],
  ['2018-01-25T13:55:00Z', 'Juno Park <juno@parkandflame.kr>', 'Second location, same look?', 'Inbox,Clients,Opened', 'We signed the lease for a second room. Same identity, new colour?'],
  ['2018-03-09T11:15:00Z', 'Tomas Reyes <tomas@harborsmoke.com>', 'Harbor Smoke menu reprint', 'Inbox,Clients,Opened', 'Prices went up a little. Can you update the menu file and send it to the printer?'],
  ['2018-04-30T17:05:00Z', 'Otto Brandt <otto@brandtpaper.de>', 'Your paper order is on its way', 'Inbox,Suppliers,Opened', 'Two reams of cotton stock left the warehouse today.'],
  ['2018-06-18T10:00:00Z', 'Ada Novak <ada@novakphoto.co>', 'Studio move, new address', 'Inbox,Clients,Opened', 'We moved to the old bakery on Mill Street. Same phone number.'],
];
const TAKEOUT_SUBJECTS = TAKEOUT.map((m) => m[2]);

function takeoutMbox(ownerEmail) {
  return TAKEOUT.map(([iso, from, subject, labels, body], i) => {
    const d = new Date(iso);
    return [
      `From 1590${String(d.getTime()).padStart(15, '0')}@xxx ${d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, '$1 $3 $2 $5 +0000 $4')}`,
      `X-GM-THRID: 1530${String(d.getTime() + i).padStart(15, '0')}`,
      `X-Gmail-Labels: ${labels}`,
      `From: ${from}`,
      `To: Rowan Hale <${ownerEmail}>`,
      `Subject: ${subject}`,
      `Date: ${d.toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <takeout-${i + 1}-${d.getTime()}@mail.gmail.test>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
      '',
      '',
    ].join('\n');
  }).join('');
}

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 2e', function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name }));
    // The account rows' data-usage hover card never gets its stats in the
    // harness and sat on "Loading..." under a resting pointer (ph-tier2a).
    await setSetting('transferHoverEnabled', false);
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-tier2e.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 31. Download modes + Hoarder (Premium).
  it('c31-download-modes', async function () {
    const MODE = '[data-testid="download-mode"]';
    const RADIO = `${MODE} [role="radio"]`;
    const usageText = () => {
      const row = [...document.querySelectorAll('[data-testid="settings-page"] .bg-mail-bg')]
        .find((e) => e.offsetHeight > 0 && (e.innerText || '').includes('Local storage usage'));
      return row ? (row.innerText || '').replace(/\s+/g, ' ').trim() : null;
    };
    const hint = (s) => (document.querySelector(`${s} > p.text-sm`)?.innerText || '').slice(0, 80);
    const pick = async (take, text, label, holdMs) => {
      await take.click(RADIO, label, { text });
      await take.waitFor((s, t) => [...document.querySelectorAll(s)].some((b) => (b.innerText || '').includes(t) && b.getAttribute('aria-checked') === 'true'),
        `${label} checked`, 4000, RADIO, text);
      facts[`c31Hint_${label}`] = await browser.execute(hint, MODE);
      await take.hold(holdMs);
    };
    await shoot(this, 'c31-download-modes', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.tab.storage'), null, visible, 'download mode', MODE);
      await take.reveal(MODE, 'download-mode', { ms: 800 });
      await take.hold(600);
      await pick(take, L('settings.storage.modeOnDemand'), 'on-demand', 1700);
      await pick(take, L('settings.storage.modeKeepRecent'), 'keep-recent', 700);
      await take.click(RADIO, 'window-3', { text: L('settings.storage.mo3') });
      await take.hold(450);
      await take.click(RADIO, 'window-6', { text: L('settings.storage.mo6') });
      await take.hold(450);
      await take.click(RADIO, 'window-12', { text: L('settings.storage.year1') });
      await take.hold(900);
      facts.c31WindowAfter = await browser.execute(() => window.__SETTINGS_STORE__.getState().localCacheDurationMonths);
      await pick(take, L('settings.storage.modeIndexOnly'), 'index-only', 1500);
      await pick(take, L('settings.storage.modeHoarder'), 'hoarder', 2600);
      if (await browser.execute(visible, '[data-testid="download-mode-upsell"]')) throw new Error('Hoarder shows the upsell: the Premium seed did not take');
      facts.c31ModeAfter = await browser.execute(() => window.__SETTINGS_STORE__.getState().fetchMode);
      // The storage numbers under the control, once the usage RPC answered.
      facts.c31UsageSettled = await waitPage((t) => {
        const row = [...document.querySelectorAll('[data-testid="settings-page"] .bg-mail-bg')]
          .find((e) => e.offsetHeight > 0 && (e.innerText || '').includes('Local storage usage'));
        return !!row && !(row.innerText || '').includes(t);
      }, { timeout: 8000, interval: 200 }, L('settings.storage.calculating'));
      facts.c31Usage = await browser.execute(usageText);
      if (await tagFirst('[data-testid="settings-page"] .bg-mail-bg', 'Local storage usage', 'usage')) {
        await take.reveal('[data-footage-target="usage"]', 'usage', { ms: 900 });
        await take.moveTo('[data-footage-target="usage"]', 'usage-row');
      }
      await take.hold(1800);
      console.log(`[footage] c31 ${JSON.stringify({ start: facts.c31Start, hints: Object.keys(facts).filter((k) => k.startsWith('c31Hint')), mode: facts.c31ModeAfter, window: facts.c31WindowAfter, usage: facts.c31Usage, settled: facts.c31UsageSettled })}`);
    }, {
      prepare: async () => {
        facts.c31Start = await browser.execute(() => {
          const s = window.__SETTINGS_STORE__.getState();
          return { fetchMode: s.fetchMode, window: s.localCacheDurationMonths, fetchModes: s.fetchModes, plan: s.billingProfile?.plan || s.billingProfile?.status || null };
        });
        // Keep Recent with the 12-month default is the starting state the clip moves away from and back to.
        if (facts.c31Start.fetchMode !== 'keepRecent') await setSetting('fetchMode', 'keepRecent');
        if (facts.c31Start.window !== 12) await setSetting('localCacheDurationMonths', 12);
        console.log(`[setup] c31 start ${JSON.stringify(facts.c31Start)}`);
      },
      after: async () => {
        // Back to what the boot had (the harness disables Hoarder and eviction, so nothing ran meanwhile).
        await setSetting('fetchMode', facts.c31Start?.fetchMode || 'keepRecent');
        await setSetting('localCacheDurationMonths', facts.c31Start?.window ?? 12);
        facts.c31Restored = await browser.execute(() => {
          const s = window.__SETTINGS_STORE__.getState();
          return { fetchMode: s.fetchMode, window: s.localCacheDurationMonths };
        });
      },
    });
  });

  // 33. MBOX and Google Takeout import, as a separate folder on this computer.
  it('c33-mbox-takeout-import', async function () {
    const DIALOG = '[data-testid="mbox-import-dialog"]';
    const LABELS = '[data-testid="mbox-import-use-labels"]';
    const CONFIRM = '[data-testid="mbox-import-confirm"]';
    const CHIP = '[data-testid="bulk-save-progress"]';
    const LOCAL = '[data-testid="local-folders"]';
    const ALERTS_KEY = 'mv-footage-mbox-alerts';
    const alerts = () => browser.execute((k) => JSON.parse(sessionStorage.getItem(k) || '[]'), ALERTS_KEY);
    await shoot(this, 'c33-mbox-takeout-import', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.tab.backup'), null,
        (t) => [...document.querySelectorAll('[data-testid="settings-page"] button')].some((b) => b.offsetHeight > 0 && (b.textContent || '').trim() === t),
        'Import MBOX button', L('settings.backup.restore.importMbox'));
      if (!(await tagFirst('[data-testid="settings-page"] button', L('settings.backup.restore.importMbox'), 'import-mbox'))) throw new Error('no Import MBOX button');
      await take.reveal('[data-footage-target="import-mbox"]', 'mbox-section', { ms: 800 });
      await take.hold(700);
      await take.click('[data-footage-target="import-mbox"]', 'import-mbox');
      await take.waitFor((d, c) => !!document.querySelector(d)?.offsetHeight && !!document.querySelector(c) && !document.querySelector(c).disabled,
        'options dialog read the file', 30000, DIALOG, CONFIRM);
      facts.c33LabelsOffered = await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 5000, interval: 150 }, LABELS);
      if (!facts.c33LabelsOffered) throw new Error('the dialog never offered "Use Gmail labels" (probe: no labels or folders unknown)');
      facts.c33Dialog = await browser.execute((d) => (document.querySelector(d)?.innerText || '').replace(/\s+/g, ' ').slice(0, 900), DIALOG);
      await take.hold(1200);
      // The Takeout part: each message to the folder named by its label.
      await take.moveTo(LABELS, 'use-gmail-labels');
      await take.hold(1500);
      await take.click('[data-testid="mbox-import-mode-server"]', 'mode-server');
      await take.hold(1100);
      await take.click('[data-testid="mbox-import-mode-folder"]', 'mode-folder');
      await take.waitFor((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-testid="mbox-import-folder"]'),
        'separate folder mode', 4000, '[data-testid="mbox-import-mode-folder"]');
      await take.hold(1000);
      await take.click(CONFIRM, 'import');
      await take.waitFor((d) => !document.querySelector(d), 'dialog closed', 8000, DIALOG);
      // Settings closes so the corner progress and the new folder show over the window.
      facts.c33ChipUnderSettings = await browser.execute(onTop, CHIP);
      await closeSettingsByClick(take);
      facts.c33ChipAfterClose = await browser.execute(onTop, CHIP);
      facts.c33ChipText = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 160), CHIP);
      take.note('chip', { at: Number(take.t(Date.now()).toFixed(3)), onTop: facts.c33ChipAfterClose, text: facts.c33ChipText });
      await take.waitFor((k) => JSON.parse(sessionStorage.getItem(k) || '[]').length > 0, 'import result', 60000, ALERTS_KEY);
      facts.c33Alerts = await alerts();
      take.note('result', { at: Number(take.t(Date.now()).toFixed(3)), alerts: facts.c33Alerts });
      if (facts.c33Alerts.join('\n').includes('did not finish')) throw new Error(`import failed: ${facts.c33Alerts.join(' | ')}`);
      // The new folder opens with its rows; its sidebar entry under "On this computer".
      await take.waitFor((row, subj) => [...document.querySelectorAll(row)].some((r) => (r.innerText || '').includes(subj)),
        'imported rows', 20000, SEL.row, TAKEOUT_SUBJECTS[TAKEOUT_SUBJECTS.length - 1]);
      await take.waitFor(visible, 'local folders group', 10000, LOCAL);
      await take.reveal(LOCAL, 'local-folders', { ms: 700 });
      await take.moveTo(`${LOCAL} [data-testid="folder-row"]`, 'new-folder', { dur: 700 });
      facts.c33Local = await browser.execute((s, row) => {
        const st = window.__MAIL_STORE__?.getState?.();
        const g = document.querySelector(s);
        return {
          group: g?.getAttribute('aria-label') || null,
          rows: g ? [...g.querySelectorAll('[data-testid="folder-row"]')].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()) : [],
          activeMailbox: st?.activeMailbox, activeAccountId: st?.activeAccountId,
          listRows: [...document.querySelectorAll(row)].length,
          firstRows: [...document.querySelectorAll(row)].slice(0, 4).map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 80)),
        };
      }, LOCAL, SEL.row);
      await take.hold(2600);
      console.log(`[footage] c33 ${JSON.stringify({ labels: facts.c33LabelsOffered, chip: [facts.c33ChipUnderSettings, facts.c33ChipAfterClose, facts.c33ChipText], alerts: facts.c33Alerts, local: facts.c33Local })}`);
    }, {
      prepare: async () => {
        const work = (browser.demoAccounts || [])[0];
        if (!work) throw new Error('no demo account');
        const dir = join(browser.footageDataDir, 'Takeout', 'Mail');
        mkdirSync(dir, { recursive: true });
        const source = join(dir, 'All mail Including Spam and Trash.mbox');
        writeFileSync(source, takeoutMbox(work.email));
        facts.c33Source = { path: source, messages: TAKEOUT.length, account: work.email };
        // The native open panel is skipped (VITE_E2E seam); the result alert is
        // captured, read back so a silently refused stub fails here, not on camera.
        const installed = await browser.execute((path, key) => {
          window.__MV_MBOX_SOURCE__ = path;
          sessionStorage.removeItem(key);
          const capture = (m) => {
            const seen = JSON.parse(sessionStorage.getItem(key) || '[]');
            seen.push(String(m));
            sessionStorage.setItem(key, JSON.stringify(seen));
          };
          capture.__mvCapture = true;
          window.alert = capture;
          return { source: window.__MV_MBOX_SOURCE__ === path, alert: window.alert?.__mvCapture === true };
        }, source, ALERTS_KEY);
        facts.c33Seam = installed;
        if (!installed.source || !installed.alert) throw new Error(`seam not installed: ${JSON.stringify(installed)}`);
        console.log(`[setup] c33 ${JSON.stringify(facts.c33Source)}`);
      },
      after: async () => {
        await browser.execute(() => { delete window.__MV_MBOX_SOURCE__; });
      },
    });
  });
});
