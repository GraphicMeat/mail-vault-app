/**
 * Product Hunt tour, the dark-mode moment (docs/product-hunt-demo-script.md,
 * "Dark flip uses the real sun/moon button"): one app boot, one `it`.
 *
 *   c00-dark-flip   the light work INBOX, the sidebar footer's moon button,
 *                   the UI goes Dark Graphite, the pointer crosses the list,
 *                   the sun button, back to Light Graphite
 *
 * Run with FOOTAGE_THEME=light: the take starts light (Take.start checks that
 * frame 0 only), flips to dark and ends light again, so nothing after it sees a
 * dark page.
 *
 * The native title bar. The app's toggle (stores/themeStore.js toggleTheme)
 * only sets `data-theme` on the page; nothing in the app sets the window's
 * appearance, which follows the system. A light run pins the window to light
 * (lib/scene.js setWindowTheme), as a Light-system Mac shows it: after the flip
 * the bar stays light over the dark UI. FOOTAGE_WINDOW_THEME=system hands the
 * window back to the system (setTheme(null); the mini runs Dark), as a
 * Dark-system Mac shows it: a dark bar over the light UI, matching after the
 * flip. That take is named c00-dark-flip-systembar so it never replaces the
 * pinned one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import { L, probe, quiet, bootToInbox, resetView, beforeTake, since, setSetting } from '../lib/scene.js';

const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const SYSTEM_BAR = process.env.FOOTAGE_WINDOW_THEME === 'system';
const CLIP = SYSTEM_BAR ? 'c00-dark-flip-systembar' : 'c00-dark-flip';
const facts = { clip: CLIP, windowThemeMode: SYSTEM_BAR ? 'system' : 'pinned-light' };

const TO_DARK = `button[title="${L('sidebar.switchDarkMode')}"]`;
const TO_LIGHT = `button[title="${L('sidebar.switchLightMode')}"]`;

/** The window's appearance as Tauri reports it (null = no window api). */
function windowTheme() {
  return browser.executeAsync((done) => {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!win?.theme) { done(null); return; }
    Promise.resolve(win.theme()).then((t) => done(t)).catch((e) => done(`error: ${e}`));
  });
}

/** Visible buttons matching `selector`, with their boxes. */
function visibleButtons(selector) {
  return browser.execute((s) => [...document.querySelectorAll(s)]
    .map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })), selector);
}

const themeIs = (t) => document.documentElement.getAttribute('data-theme') === t;

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

describe('footage: Product Hunt theme flip', function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    // As in the other specs: the account rows' data-usage hover card never
    // gets its stats in the harness and would sit on "Loading..." over the list.
    await setSetting('transferHoverEnabled', false);
    facts.windowThemeAfterBoot = await windowTheme();
    if (SYSTEM_BAR) {
      facts.windowThemeRelease = await browser.executeAsync((done) => {
        const win = window.__TAURI__?.window?.getCurrentWindow?.();
        if (!win?.setTheme) { done({ error: 'no tauri window setTheme' }); return; }
        win.setTheme(null).then(() => win.theme()).then((after) => done({ after })).catch((e) => done({ error: String(e) }));
      });
      await browser.pause(800);
      console.log(`[setup] window theme handed back to the system: ${JSON.stringify(facts.windowThemeRelease)}`);
      if (facts.windowThemeRelease.error || facts.windowThemeRelease.after !== 'dark') {
        throw new Error(`system title bar variant: window theme is ${JSON.stringify(facts.windowThemeRelease)}, expected dark (the mini runs Dark)`);
      }
    }
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-theme.facts.json'), JSON.stringify(facts, null, 2));
  });

  it('c00-dark-flip', async function () {
    await resetView();
    const p = await probe();
    if (p.theme !== 'light' || p.palette !== 'graphite') throw new Error(`not light graphite before the take: ${JSON.stringify(p)}`);
    const toDark = await visibleButtons(TO_DARK);
    facts.toggleBoxes = toDark;
    console.log(`[setup] theme toggle buttons visible: ${JSON.stringify(toDark)}`);
    if (toDark.length !== 1) throw new Error(`expected one visible "${L('sidebar.switchDarkMode')}" button, found ${toDark.length}`);
    facts.windowThemeBeforeTake = await windowTheme();
    await beforeTake(CLIP);

    const take = new Take(CLIP, { travelMs: 1000 });
    take.note('windowTheme', {
      mode: facts.windowThemeMode,
      atStart: facts.windowThemeBeforeTake,
      appToggle: 'stores/themeStore.js toggleTheme sets data-theme only; the window appearance is not touched by the app',
    });
    await take.start();
    try {
      await take.hold(3500);
      await take.click(TO_DARK, 'toggle-to-dark');
      await take.waitFor(themeIs, 'data-theme dark', 5000, 'dark');
      facts.windowThemeAfterFlip = await windowTheme();
      facts.afterFlip = await probe();
      await take.hold(1200);
      // The pointer crosses a few rows of the dark list.
      const rows = await browser.execute(() => {
        const vis = [...document.querySelectorAll('[data-testid="email-row"]')]
          .filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.top > 60 && b.bottom < window.innerHeight - 40; });
        const pick = [1, 3, 6, 9].map((i) => vis[i]).filter(Boolean);
        pick.forEach((r, i) => r.setAttribute('data-footage-target', `flip-row-${i}`));
        return pick.length;
      });
      for (let i = 0; i < rows; i++) {
        await take.moveTo(`[data-footage-target="flip-row-${i}"]`, `dark-row-${i}`, { dur: 1200 });
        await take.hold(500);
      }
      await take.hold(600);
      await take.click(TO_LIGHT, 'toggle-to-light');
      await take.waitFor(themeIs, 'data-theme light', 5000, 'light');
      facts.windowThemeAfterFlipBack = await windowTheme();
      await take.hold(4000);
      facts.rec = await finish(take, CLIP);
    } catch (e) {
      facts.error = String(e?.message || e);
      await take.abort();
      throw e;
    } finally {
      await browser.execute(() => document.querySelectorAll('[data-footage-target^="flip-row-"]')
        .forEach((el) => el.removeAttribute('data-footage-target')));
    }
    facts.end = await probe();
    console.log(`[footage] ${CLIP} window theme: start ${facts.windowThemeBeforeTake}, after flip ${facts.windowThemeAfterFlip}, after flip back ${facts.windowThemeAfterFlipBack}`);
    if (facts.end.theme !== 'light') throw new Error(`take ended ${facts.end.theme}, expected light`);
  });
});
