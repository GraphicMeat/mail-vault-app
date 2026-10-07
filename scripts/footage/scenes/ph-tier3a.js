/**
 * Product Hunt tour, Tier 3 montage batch A: short working clips (about 6 to
 * 12 s raw; the edit keeps 4 s). The theme alternates per clip, so the spec
 * runs twice, once per theme, and each clip only records in its own theme:
 *
 *   light  c34-move-accounts     Accounts: Export… (password + confirm filled, never exported), Import…
 *          c36-migration         Migration wizard: source, destination, folders, the folder mapping (never started)
 *          c38-layouts           Layout: reading pane below the list, then beside it (3 vs 2 columns)
 *          c42-idle-push         a message APPENDed to the mock server lands through IDLE, no refresh
 *          c40-languages         Language: de, fr, ja, ko, zh-Hans, pt-BR, back to en
 *   dark   c37-shortcuts         "?" opens the shortcuts sheet, scrolled; j j j k walk the list
 *          c39-fonts-text-size   Text: Inter, Atkinson Hyperlegible, IBM Plex, then 125% (webview zoom)
 *          c41-background-helper Diagnostics > Background helper: status, "Keep running in the background"
 *          c35-server-change     Accounts > Connection > Change server: verify against the mock, folders, DNS check
 *
 * Order matters: c40 is last in light (a run that dies in another language
 * breaks every English selector after it), c35 last in dark (it re-saves the
 * work account through the real change-server path).
 *
 *   FOOTAGE_THEME=light FOOTAGE_ONLY=c34-move-accounts,... bash scripts/footage/run.sh
 *
 * Nothing on screen is staged. c42's message is delivered to the mock IMAP
 * server over IMAP (ImapFlow APPEND, as tests/e2e/connected-instant-arrival does).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake,
  waitPage, since, setSetting, clickSel,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const THEME = process.env.FOOTAGE_THEME || '';
const THEME_OF = {
  'c34-move-accounts': 'light',
  'c36-migration': 'light',
  'c38-layouts': 'light',
  'c40-languages': 'light',
  'c42-idle-push': 'light',
  'c35-server-change': 'dark',
  'c37-shortcuts': 'dark',
  'c39-fonts-text-size': 'dark',
  'c41-background-helper': 'dark',
};
const want = (clip) => THEME_OF[clip] === THEME && (!ONLY.length || ONLY.includes(clip));
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

const SETTINGS = '[data-testid="settings-page"]';
const NAV = `${SETTINGS} .settings-nav-item`;
const TAB = `${SETTINGS} [role="tab"]`;
const CLOSE_SETTINGS = `${SETTINGS} button[aria-label="${L('common.close')}"]`;
const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const textOn = (t) => document.body.innerText.includes(t);

// ── Take plumbing (from ph-tier2a.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  facts[`${clip}Seconds`] = rec.seconds;
  return rec;
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`; `after` always runs. */
async function shoot(ctx, clip, body, { prepare, after } = {}) {
  if (!want(clip)) ctx.skip();
  await closeShortcutsSheet();
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
    if (after) {
      try { await after(); } catch (e) { console.error(`[setup] ${clip} after: ${e.message}`); facts[`${clip}AfterError`] = e.message; }
    }
  }
}

/**
 * resetView() does not know the shortcuts sheet (z-100, above Settings): a
 * take that failed with it open left it over every later clip. Setup only.
 */
async function closeShortcutsSheet() {
  for (let i = 0; i < 3; i++) {
    const open = await browser.execute((c) => {
      const m = document.querySelector('[data-testid="shortcuts-modal"]');
      if (!m) return false;
      m.querySelector(`button[aria-label="${c}"]`)?.click();
      return true;
    }, L('common.close'));
    if (!open) return;
    await browser.pause(600);
  }
  throw new Error('the shortcuts sheet will not close');
}

/** Tag the first visible `selector` whose trimmed text is exactly `text` (or contains it). */
function tagText(selector, text, tag, { exact = true } = {}) {
  return browser.execute((s, n, t, ex) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(s)].find((el) => {
      if (el.getBoundingClientRect().height <= 0) return false;
      const v = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return ex ? v === n : v.includes(n);
    });
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, selector, text, tag, exact);
}

async function clickText(take, selector, text, label, opts) {
  if (!(await tagText(selector, text, label, opts))) throw new Error(`${label}: no visible ${selector} reading "${text}"`);
  await take.click(`[data-footage-target="${label}"]`, label);
}

async function hoverText(take, selector, text, label, opts) {
  if (!(await tagText(selector, text, label, opts))) throw new Error(`${label}: no visible ${selector} reading "${text}"`);
  await take.hover(`[data-footage-target="${label}"]`, label);
}

/**
 * A key press with no pointer: keydown/keyup on the focused element (the
 * app's shortcut hook listens on window), logged like a typed character.
 */
async function press(take, key, label, { code } = {}) {
  const r = await browser.executeAsync((k, c, done) => {
    const target = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
    const init = { key: k, code: c || (k.length === 1 ? `Key${k.toUpperCase()}` : k), bubbles: true, cancelable: true, composed: true,
      shiftKey: k === '?', keyCode: k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0) };
    const at = Date.now();
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    requestAnimationFrame(() => done({ at, raf: Date.now() }));
  }, key, code || null);
  const c = take.cursor || { x: 0, y: 0 };
  take.log({ t: take.t(r.at), raf: take.t(r.raf), type: 'type', x: c.x, y: c.y, label, text: key.length === 1 ? key : '', key });
}

/** Settings by a real click on the sidebar's gear; the search field's focus ring is dropped. */
async function openSettingsTake(take) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await browser.execute(() => document.activeElement?.blur?.());
}

/** Settings > `navLabel` (> `tabLabel`), by real clicks; `ready` is the page predicate. */
async function toSettingsPage(take, navLabel, tabLabel, ready, what, ...args) {
  await openSettingsTake(take);
  await take.hold(700);
  await take.reveal(NAV, 'nav-reveal', { text: navLabel, ms: 600 });
  await take.click(NAV, 'nav', { text: navLabel });
  if (tabLabel) {
    await take.waitFor((s, t) => [...document.querySelectorAll(s)].some((b) => (b.innerText || '').trim() === t), `${what} tab`, 8000, TAB, tabLabel);
    await take.hold(500);
    await clickText(take, TAB, tabLabel, 'tab');
  }
  await take.waitFor(ready, what, 15000, ...args);
}

async function closeSettingsTake(take) {
  await take.click(CLOSE_SETTINGS, 'close-settings');
  await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
}

/** The text of the focused/selected message row (for facts). */
const selectedSubject = () => {
  const s = window.__MAIL_STORE__?.getState?.();
  return s?.selectedEmail?.subject || null;
};

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 3a', function () {
  this.timeout(1800000);

  before(async function () {
    if (THEME !== 'light' && THEME !== 'dark') throw new Error(`FOOTAGE_THEME must be light or dark, got "${THEME}"`);
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.theme = THEME;
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name }));
    // Same as ph-tier2a: the account rows' data-usage hover card sat on "Loading..." under a resting pointer.
    facts.transferHoverWas = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().transferHoverEnabled);
    await setSetting('transferHoverEnabled', false);
    facts.viewport0 = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, `ph-tier3a-${THEME}.facts.json`), JSON.stringify(facts, null, 2));
  });

  // ── dark ──────────────────────────────────────────────────────────────────

  // 37. The shortcuts sheet, then j/k through the list.
  it('c37-shortcuts', async function () {
    const MODAL = '[data-testid="shortcuts-modal"]';
    await shoot(this, 'c37-shortcuts', async (take) => {
      await take.hold(1200);
      await press(take, '?', 'question-mark');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'shortcuts modal', 5000, MODAL);
      await take.hold(1200);
      // The whole sheet fits in the window (nothing scrolls): the pointer reads down it instead.
      await tagText(`${MODAL} *`, 'Next email', 'sheet-next', { exact: true });
      await take.moveTo('[data-footage-target="sheet-next"]', 'sheet-next-email', { dur: 900 });
      await take.hold(1100);
      if (await tagText(`${MODAL} *`, 'Archive', 'sheet-archive', { exact: true })) {
        await take.moveTo('[data-footage-target="sheet-archive"]', 'sheet-archive', { dur: 1000 });
        await take.hold(1100);
      }
      await press(take, '?', 'close-sheet');
      if (!(await waitPage((s) => !document.querySelector(s), { timeout: 1500 }, MODAL))) {
        await press(take, 'Escape', 'escape');
        await take.waitFor((s) => !document.querySelector(s), 'shortcuts closed', 4000, MODAL);
      }
      await take.moveTo(SEL.row, 'list');
      await take.hold(500);
      const walk = [];
      for (const k of ['j', 'j', 'j', 'k']) {
        await press(take, k, `key-${k}`);
        await take.hold(850);
        walk.push({ key: k, subject: await browser.execute(selectedSubject) });
      }
      facts.c37Walk = walk;
      await take.hold(1200);
      console.log(`[footage] c37 walk ${JSON.stringify(walk)}`);
      if (walk.filter((w) => w.subject).length < 3) throw new Error(`j/k selected nothing: ${JSON.stringify(walk)}`);
    });
  });

  // 39. App font and text size, live.
  it('c39-fonts-text-size', async function () {
    const SIZE = `${SETTINGS} [role="radiogroup"][aria-label="${L('settings.text.size')}"] button`;
    const fontOn = (id) => document.querySelector(`[data-testid="font-${id}"]`)?.getAttribute('aria-pressed') === 'true';
    await shoot(this, 'c39-fonts-text-size', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.appearance.appearance'), L('settings.appearance.section.text'),
        () => !!document.querySelector('[data-testid="font-inter"]'), 'text settings');
      await take.hold(900);
      for (const id of ['system', 'inter', 'atkinson', 'ibm-plex-sans']) {
        await take.click(`[data-testid="font-${id}"]`, `font-${id}`);
        await take.waitFor(fontOn, `font ${id}`, 3000, id);
        await take.hold(id === 'atkinson' ? 1100 : 800);
      }
      await take.click('[data-testid="font-atkinson"]', 'font-atkinson-again');
      await take.waitFor(fontOn, 'font atkinson', 3000, 'atkinson');
      await take.hold(700);
      // The size is native webview zoom: every pointer position after this
      // click would be logged in the old scale, so it is the last pointer action.
      await clickText(take, SIZE, '125%', 'size-125');
      facts.c39ZoomSeen = await waitPage((w) => window.innerWidth < w - 50, { timeout: 4000, interval: 100 }, facts.viewport0.w);
      facts.c39Zoomed = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
      await take.hold(1600);
      await press(take, 'Escape', 'escape-settings');
      if (!(await waitPage(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, { timeout: 3000 }))) {
        take.cut('close-settings', 'Escape did not close Settings; closed in the page');
        await clickSel(CLOSE_SETTINGS);
        await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 5000);
      }
      await take.hold(2600);
      facts.c39Font = await browser.execute(() => getComputedStyle(document.body).fontFamily);
    }, {
      after: async () => {
        await setSetting('textScale', 1);
        await setSetting('appFont', 'instrument-sans');
        const w0 = facts.viewport0.w;
        await waitPage((w) => Math.abs(window.innerWidth - w) < 2 && window.devicePixelRatio === 2, { timeout: 10000 }, w0);
        facts.c39Restored = await browser.execute(() => ({ w: window.innerWidth, dpr: window.devicePixelRatio }));
      },
    });
  });

  // 41. The background helper: what keeps MailVault syncing with the window closed.
  it('c41-background-helper', async function () {
    await shoot(this, 'c41-background-helper', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.diagnostics'), L('settings.tab.daemon'),
        (t) => document.body.innerText.includes(t), 'helper connected', L('settings.daemon.helperConnected'));
      await take.hold(1200);
      facts.c41Page = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 900), SETTINGS);
      facts.c41Switch = await browser.execute(() => {
        const sw = document.querySelector('[data-testid="daemon-always-on"]');
        return sw ? { on: sw.getAttribute('aria-checked') || sw.getAttribute('aria-pressed'), disabled: !!sw.disabled,
          reason: document.querySelector('[data-testid="daemon-always-on-reason"]')?.innerText || null } : null;
      });
      // Never toggled: on an installed build it registers a login item.
      if (facts.c41Switch) {
        await take.hover('[data-testid="daemon-always-on"]', 'always-on-switch');
        await take.hold(2200);
      }
      await clickText(take, `${SETTINGS} button`, L('settings.daemon.testConnection'), 'test-connection');
      await take.waitFor((t) => document.body.innerText.includes(t), 'helper connected again', 10000, L('settings.daemon.helperConnected'));
      await take.hold(2400);
      console.log(`[footage] c41 switch ${JSON.stringify(facts.c41Switch)}`);
    });
  });

  // 35. Guided server change: re-verified against the same mock server, local folders, DNS health.
  it('c35-server-change', async function () {
    const work = (browser.demoAccounts || [])[0];
    const PASS = `[role="dialog"] input[aria-label="${L('changeServer.password')}"]`;
    const stepNow = (skip, done, checking) => {
      const btns = [...document.querySelectorAll('[role="dialog"] button')].filter((b) => b.offsetHeight > 0).map((b) => (b.textContent || '').trim());
      if (btns.includes(skip)) return 2;
      if (btns.includes(done) && !document.body.innerText.includes(checking)) return 3;
      const err = [...document.querySelectorAll('[role="dialog"] .text-mail-danger')].find((e) => e.offsetHeight > 0);
      if (err) return `error: ${(err.innerText || '').trim()}`;
      return 0;
    };
    await shoot(this, 'c35-server-change', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.accounts'), null,
        () => !!document.querySelector('.account-settings-account-button'), 'accounts');
      await take.hold(500);
      await clickText(take, '.account-settings-account-button', work.email, 'work-account', { exact: false });
      await take.hold(500);
      await take.waitFor((s, t) => [...document.querySelectorAll(s)].some((b) => (b.innerText || '').trim() === t), 'connection tab', 8000, TAB, L('settings.accounts.sectionConnection'));
      await clickText(take, TAB, L('settings.accounts.sectionConnection'), 'connection');
      await take.waitFor(textOn, 'change server button', 8000, L('settings.accounts.changeServer'));
      await take.hold(900);
      await clickText(take, `${SETTINGS} button`, L('settings.accounts.changeServer'), 'change-server');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'change server dialog', 8000, PASS);
      facts.c35Title = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.innerText).join(' | '));
      await take.hold(1300);
      await take.click(PASS, 'password');
      // The mock server's own password (the run's fixture), so verify really succeeds.
      await take.type(PASS, work.password, 'password', { base: 75, jitter: 25, seed: 12 });
      await take.hold(700);
      // Verify can't finish in the harness: SMTP needs FOOTAGE_SMTP_PLAINTEXT=1, and then
      // the frontend's storePassword wants a default keychain the run's temp HOME lacks
      // (run d2: "A default keychain could not be found"). So by default the take
      // stops at the filled form; FOOTAGE_C35_VERIFY=1 tries the whole flow.
      if (process.env.FOOTAGE_C35_VERIFY !== '1') {
        await browser.execute((p) => {
          const d = [...document.querySelectorAll('[role="dialog"]')].reverse().find((x) => x.querySelector(p));
          d?.setAttribute('data-footage-dialog', 'change-server');
        }, PASS);
        const CS = '[data-footage-dialog="change-server"] button';
        await hoverText(take, CS, L('changeServer.verifySave'), 'verify-hover');
        await take.hold(1900);
        await clickText(take, CS, L('common.cancel'), 'cancel');
        await take.waitFor((s) => !document.querySelector(s), 'dialog closed', 5000, PASS);
        await take.hold(1000);
        return;
      }
      await clickText(take, '[role="dialog"] button', L('changeServer.verifySave'), 'verify');
      let step = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        step = await browser.execute(stepNow, L('changeServer.skip'), L('common.done'), 'Checking DNS records');
        if (step) break;
        await browser.pause(150);
      }
      facts.c35Verify = { step, seconds: Number(since(t0)) };
      console.log(`[footage] c35 verify -> ${JSON.stringify(facts.c35Verify)}`);
      if (typeof step === 'string' || !step) {
        await take.hold(2000);
        throw new Error(`change server did not verify: ${step || 'timeout'}`);
      }
      if (step === 2) {
        facts.c35Folders = await browser.execute(() => (document.querySelector('[role="dialog"] ul')?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
        await take.hold(900);
        await take.reveal('[role="dialog"] ul', 'folders', { ms: 500 });
        await take.moveTo('[role="dialog"] ul', 'folder-list');
        await take.hold(1800);
        // Skip, never Restore (that would upload the whole local vault to the mock).
        await clickText(take, '[role="dialog"] button', L('changeServer.skip'), 'skip');
      }
      const t1 = Date.now();
      await take.waitFor((d, c) => [...document.querySelectorAll('[role="dialog"] button')].some((b) => (b.textContent || '').trim() === d)
        && !document.body.innerText.includes(c), 'dns check done', 25000, L('common.done'), 'Checking DNS records');
      facts.c35Dns = { seconds: Number(since(t1)), text: await browser.execute(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => (x.innerText || '').includes('Change server'));
        return (d?.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
      }) };
      console.log(`[footage] c35 dns ${JSON.stringify(facts.c35Dns)}`);
      await take.hold(2800);
      await clickText(take, '[role="dialog"] button', L('common.done'), 'done');
      await take.hold(900);
    });
  });

  // ── light ─────────────────────────────────────────────────────────────────

  // 34. Move to another computer: the encrypted export, and the import entry.
  it('c34-move-accounts', async function () {
    const PW = '#transfer-export-password';
    const CONFIRM = '#transfer-export-confirm';
    // An invented throwaway password; nothing is exported (Export opens a save dialog and is never pressed).
    const SECRET = 'copper-lantern-harbor';
    await shoot(this, 'c34-move-accounts', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.accounts'), null, textOn, 'transfer section', L('settings.transfer.title'));
      await take.hold(600);
      await take.reveal(`${SETTINGS} button`, 'transfer', { text: L('settings.transfer.export'), ms: 700 });
      await take.hold(900);
      await clickText(take, `${SETTINGS} button`, L('settings.transfer.export'), 'export');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'export dialog', 8000, PW);
      await take.hold(1000);
      await take.click(PW, 'password');
      await take.type(PW, SECRET, 'password', { base: 70, jitter: 25, seed: 21 });
      await take.hold(400);
      await take.click(CONFIRM, 'confirm');
      await take.type(CONFIRM, SECRET, 'confirm', { base: 60, jitter: 20, seed: 22 });
      await take.hold(500);
      facts.c34Mismatch = await browser.execute((t) => document.body.innerText.includes(t), L('settings.transfer.passwordMismatch'));
      facts.c34ExportEnabled = await browser.execute((t) => [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => (b.textContent || '').trim() === t).map((b) => !b.disabled), L('settings.transfer.exportTitle'));
      await hoverText(take, '[role="dialog"] button', L('settings.transfer.exportTitle'), 'export-button');
      await take.hold(1700);
      await clickText(take, '[role="dialog"] button', L('common.cancel'), 'cancel-export');
      await take.waitFor((s) => !document.querySelector(s), 'export closed', 5000, PW);
      // The export modal opens in the main window and closes Settings (run l1),
      // so the Import entry is reached through Settings again.
      await take.hold(600);
      if (!(await browser.execute(settingsOpen))) {
        await toSettingsPage(take, L('settings.tab.accounts'), null, textOn, 'transfer section', L('settings.transfer.title'));
        await take.reveal(`${SETTINGS} button`, 'transfer-2', { text: L('settings.transfer.import'), ms: 600 });
        await take.hold(500);
      }
      await clickText(take, `${SETTINGS} button`, L('settings.transfer.import'), 'import');
      await take.waitFor((t) => [...document.querySelectorAll('[role="dialog"] button')].some((b) => (b.textContent || '').trim() === t),
        'import dialog', 8000, L('settings.transfer.chooseFile'));
      await take.hold(1000);
      await hoverText(take, '[role="dialog"] button', L('settings.transfer.chooseFile'), 'choose-file');
      await take.hold(1800);
      await clickText(take, '[role="dialog"] button', L('common.cancel'), 'cancel-import');
      await take.hold(900);
      console.log(`[footage] c34 mismatch ${facts.c34Mismatch}, export enabled ${JSON.stringify(facts.c34ExportEnabled)}`);
    });
  });

  // 36. Migration between IMAP accounts, up to the folder mapping (never started).
  it('c36-migration', async function () {
    const accounts = browser.demoAccounts || [];
    const src = accounts[0];
    const dst = accounts[2] || accounts[1];
    const ROW = `${SETTINGS} button[aria-pressed]`;
    const NEXT = L('common.next');
    const nextEnabled = (s, n) => [...document.querySelectorAll(`${s} button`)].some((b) => (b.textContent || '').trim() === n && !b.disabled
      && !b.className.includes('cursor-not-allowed'));
    await shoot(this, 'c36-migration', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.migration'), null, textOn, 'migration wizard', L('settings.migration.selectSourceAccount'));
      await take.hold(1100);
      await clickText(take, ROW, src.email, 'source', { exact: false });
      await take.waitFor(nextEnabled, 'next (source)', 4000, SETTINGS, NEXT);
      await take.hold(600);
      await clickText(take, `${SETTINGS} button`, NEXT, 'next-1');
      await take.waitFor(textOn, 'destination step', 5000, L('settings.migration.selectDestinationAccount'));
      await take.hold(900);
      await clickText(take, ROW, dst.email, 'destination', { exact: false });
      await take.waitFor(nextEnabled, 'next (destination)', 4000, SETTINGS, NEXT);
      await take.hold(600);
      await clickText(take, `${SETTINGS} button`, NEXT, 'next-2');
      await take.waitFor(textOn, 'folders step', 5000, L('settings.migration.selectFoldersMigrate'));
      await take.waitFor((s) => !document.querySelector(`${s} .animate-spin`) && document.querySelectorAll(`${s} label input[type="checkbox"]`).length >= 2,
        'folder list', 30000, SETTINGS);
      facts.c36Folders = await browser.execute((s) => [...document.querySelectorAll(`${s} label`)].map((l) => (l.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean), SETTINGS);
      await take.hold(2000);
      await take.waitFor(nextEnabled, 'next (folders)', 4000, SETTINGS, NEXT);
      await clickText(take, `${SETTINGS} button`, NEXT, 'next-3');
      await take.waitFor(textOn, 'review step', 5000, L('settings.migration.sourceFolder'));
      await take.hold(700);
      facts.c36Review = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 900), SETTINGS);
      await take.moveTo(`${SETTINGS} .grid.grid-cols-\\[1fr_auto_1fr\\]`, 'mapping');
      await take.hold(2800);
      // The start button is never pressed.
      await hoverText(take, `${SETTINGS} button`, L('settings.migration.startMigration'), 'start-hover');
      await take.hold(1200);
      console.log(`[footage] c36 folders ${JSON.stringify(facts.c36Folders)}`);
    });
  });

  // 38. Layout: the reading pane below the list (2 columns), then beside it (3).
  it('c38-layouts', async function () {
    const LAYOUT = '[data-testid="appearance-layout-section"] .settings-segments button';
    const layoutIs = (m) => window.__SETTINGS_STORE__?.getState?.().layoutMode === m;
    const toLayout = (take) => toSettingsPage(take, L('settings.appearance.appearance'), L('settings.appearance.section.layout'),
      () => !!document.querySelector('[data-testid="appearance-layout-section"]'), 'layout settings');
    await shoot(this, 'c38-layouts', async (take) => {
      await take.hold(700);
      await take.click('[data-footage-target="row-a"]', 'open-row');
      await take.hold(1200);
      await toLayout(take);
      await take.hold(900);
      await clickText(take, LAYOUT, L('workspace.belowList'), 'below-list');
      await take.waitFor(layoutIs, 'two-column', 3000, 'two-column');
      await take.hold(1300);
      await closeSettingsTake(take);
      await take.hold(1800);
      await take.click('[data-footage-target="row-b"]', 'open-row-2');
      await take.hold(1800);
      await toLayout(take);
      await take.hold(700);
      await clickText(take, LAYOUT, L('workspace.besideList'), 'beside-list');
      await take.waitFor(layoutIs, 'three-column', 3000, 'three-column');
      await take.hold(1100);
      await closeSettingsTake(take);
      await take.hold(2600);
    }, {
      prepare: async () => {
        const ok = await browser.execute(() => {
          document.querySelectorAll('[data-footage-target^="row-"]').forEach((el) => el.removeAttribute('data-footage-target'));
          const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter((r) => r.getBoundingClientRect().height > 0);
          if (rows.length < 4) return false;
          rows[0].setAttribute('data-footage-target', 'row-a');
          rows[2].setAttribute('data-footage-target', 'row-b');
          return true;
        });
        if (!ok) throw new Error('no rows to open');
      },
      after: async () => { await setSetting('layoutMode', 'three-column'); },
    });
  });

  // 42. New mail arrives over IDLE: delivered to the mock server, no refresh.
  it('c42-idle-push', async function () {
    const work = (browser.demoAccounts || [])[0];
    const SUBJECT = 'Menu proofs are ready for sign-off';
    const deliver = async (from) => {
      const client = new ImapFlow({ host: '127.0.0.1', port: work.imapPort, secure: false,
        auth: { user: work.email, pass: work.password }, logger: false });
      await client.connect();
      try {
        const now = new Date();
        const raw = Buffer.from([
          `From: ${from}`,
          `To: ${work.name || 'Rowan Marsh'} <${work.email}>`,
          `Subject: ${SUBJECT}`,
          `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
          `Message-ID: <ph-c42-${now.getTime()}@primecut.studio>`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Hi Rowan,',
          '',
          'The autumn menu proofs are ready. Two small changes from last round: the',
          'brisket line moved up, and the prices are set in the lighter weight.',
          '',
          'If you are happy with them, I will send them to print this afternoon.',
          '',
          'Priya',
          '',
        ].join('\r\n'));
        return await client.append('INBOX', raw, [], now);
      } finally {
        await client.logout();
      }
    };
    await shoot(this, 'c42-idle-push', async (take) => {
      await take.hold(1800);
      await take.moveTo(SEL.row, 'list-top');
      await take.hold(700);
      const t0 = Date.now();
      take.note('delivered', { at: Number(take.t(t0).toFixed(3)) });
      const res = await deliver(facts.c42From);
      facts.c42Append = { uid: res?.uid ?? null, ms: Date.now() - t0 };
      await take.waitFor((s) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(s)),
        'new row', 8000, SUBJECT);
      facts.c42ArrivalMs = Date.now() - t0;
      take.note('arrived', { at: Number(take.t(Date.now()).toFixed(3)), ms: facts.c42ArrivalMs });
      facts.c42Unread = await browser.execute(() => [...document.querySelectorAll('.mail-sidebar [class*="badge"], .mail-sidebar [data-testid*="unread"]')]
        .filter((e) => e.offsetHeight > 0).map((e) => (e.innerText || '').trim()).slice(0, 6));
      await take.hold(3200);
      facts.c42Top = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 3)
        .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 100)));
      console.log(`[footage] c42 arrival ${facts.c42ArrivalMs} ms; ${JSON.stringify({ append: facts.c42Append, unread0: facts.c42Unread0, unread: facts.c42Unread, top: facts.c42Top })}`);
    }, {
      prepare: async () => {
        facts.c42From = await browser.execute(() => {
          const rows = window.__MAIL_STORE__?.getState?.().sortedEmails || [];
          const hit = rows.find((e) => /Priya/.test(JSON.stringify(e.from || '')));
          const f = hit?.from;
          const addr = f && (f.address || f.email || f.value?.[0]?.address);
          const name = f && (f.name || f.value?.[0]?.name);
          return addr ? `${name || 'Priya'} <${addr}>` : null;
        }) || 'Priya <priya@tenderloin.type>';
        facts.c42Unread0 = await browser.execute(() => [...document.querySelectorAll('.mail-sidebar [class*="badge"], .mail-sidebar [data-testid*="unread"]')]
          .filter((e) => e.offsetHeight > 0).map((e) => (e.innerText || '').trim()).slice(0, 6));
        // resetView re-opened the INBOX: give the IDLE watcher time to re-arm.
        await browser.pause(5000);
      },
    });
  });

  // 40. The UI language, live: several of the nine, back to English.
  it('c40-languages', async function () {
    const rowOn = (c) => document.querySelector(`[data-testid="language-row-${c}"]`)?.getAttribute('aria-checked') === 'true';
    const navText = () => (document.querySelector('[data-testid="settings-page"] .settings-nav-item')?.innerText || '').trim();
    const english = L('settings.appearance.appearance');
    await shoot(this, 'c40-languages', async (take) => {
      await take.hold(800);
      await toSettingsPage(take, english, L('settings.tab.language'),
        () => !!document.querySelector('[data-testid="language-row-de"]'), 'language list');
      await take.hold(1000);
      const seen = [];
      for (const code of ['de', 'fr', 'ja', 'ko', 'zh-Hans', 'pt-BR', 'en']) {
        await take.click(`[data-testid="language-row-${code}"]`, `lang-${code}`);
        await take.waitFor(rowOn, `${code} checked`, 5000, code);
        await take.waitFor((e, c) => (c === 'en' ? document.querySelector('[data-testid="settings-page"] .settings-nav-item')?.innerText?.trim() === e
          : document.querySelector('[data-testid="settings-page"] .settings-nav-item')?.innerText?.trim() !== e), `${code} rendered`, 6000, english, code);
        seen.push({ code, nav: await browser.execute(navText) });
        await take.hold(code === 'en' ? 1200 : 1050);
      }
      facts.c40Seen = seen;
      await closeSettingsTake(take);
      await take.hold(1500);
      console.log(`[footage] c40 ${JSON.stringify(seen)}`);
    }, {
      after: async () => {
        const lang = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().language);
        if (lang !== 'en') {
          console.warn(`[setup] c40 left the UI in ${lang}; switching back`);
          if (!(await clickSel('[data-testid="language-row-en"]'))) await setSetting('language', 'en');
          await browser.pause(1500);
        }
      },
    });
  });
});
