/**
 * S4 "Search everything. Offline." - one take.
 *
 * Inbox at rest, the cursor goes to Search, the query is typed with a human
 * rhythm, Enter, the results land, a beat, the first result opens, a beat.
 *
 * Every step waits on the app's own state before the next one starts, so the
 * pauses in the clip are the ones written here, not the app catching up.
 */
import { waitForApp, waitForEmails } from '../../../tests/e2e/helpers.js';
import { raiseWindow } from '../../screenshots/window.js';
import { makeLabels } from '../../screenshots/labels.js';
import { Take, windowSize, restoreMotion, sampleLoad, windowInfo, pointer, OUT_DIR } from '../lib/footage.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const L = makeLabels('en');
const QUERY = process.env.FOOTAGE_QUERY || 'invoice';

const SEL = {
  toggle: '[data-testid="mail-search-toggle"]',
  input: '[data-testid="mail-search-input"]',
  row: '[data-testid="email-row"]',
};

describe('footage: s4-search', function () {
  this.timeout(600000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    await waitForApp();
    const { width, height } = windowSize();
    console.log('[footage] raise:', await raiseWindow(width, height));
    await browser.pause(1500);
    await waitForEmails();
    // The work account's INBOX, whatever the app restored.
    const email = browser.demoAccounts[0].email;
    await browser.execute((mail) => {
      document.querySelector(`.sidebar-account-open[aria-label*="${mail}"]`)?.click();
    }, email);
    await browser.pause(900);
    await browser.execute(() => {
      document.querySelector('[data-testid="folder-row"][data-path="INBOX"]')?.click();
    });
    await browser.pause(2500); // first sync settles: counts, state icons

    const geometry = await browser.executeAsync((done) => {
      const win = window.__TAURI__?.window?.getCurrentWindow?.();
      if (!win) { done({ error: 'no tauri window api' }); return; }
      Promise.all([win.outerSize(), win.innerSize(), win.scaleFactor(), win.outerPosition()])
        .then(([outer, inner, scale, pos]) => done({
          outer: [outer.width, outer.height], inner: [inner.width, inner.height], scale, pos: [pos.x, pos.y],
          viewport: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio,
          visibility: document.visibilityState,
        }))
        .catch((e) => done({ error: String(e) }));
    });
    console.log('[footage] geometry:', JSON.stringify(geometry));
    console.log('[footage] windows:', windowInfo());
    writeFileSync(join(OUT_DIR, 'geometry.json'), JSON.stringify({ requested: { width, height }, geometry, windows: windowInfo() }, null, 2));

    if (process.env.FOOTAGE_REAL_MOTION !== '0') await restoreMotion();

    // The real pointer sits on the title bar for the whole take (see pointer()).
    if (geometry.pos && geometry.outer) {
      const s = geometry.scale || 2;
      console.log('[footage] pointer parked:', pointer(geometry.pos[0] / s + geometry.outer[0] / s / 2, geometry.pos[1] / s + 16));
    }

    // Nothing open, search closed: the take starts from a quiet inbox.
    await browser.execute(() => {
      window.__SEARCH_STORE__?.getState?.().clearSearch?.();
      document.activeElement?.blur?.();
    });
    await browser.pause(800);
    const rows = await browser.execute((s) => document.querySelectorAll(s).length, SEL.row);
    if (!rows) throw new Error('inbox has no rows to start from');
  });

  it('records the take', async function () {
    const take = new Take('s4-search');
    await take.start();
    const load = sampleLoad('s4-search', 3);

    await take.hold(1000);
    await take.click(SEL.toggle, 'search-toggle');
    await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'search input', 5000, SEL.input);
    await take.focus(SEL.input, 'search-box');
    await take.hold(350);
    await take.type(SEL.input, QUERY, 'search-box');
    await take.hold(300);
    await take.submit(SEL.input, 'search-box');
    await take.waitFor((title, sel) => (document.querySelector('[data-testid="mailbox-title"]')?.textContent || '').trim() === title
      && document.querySelectorAll(sel).length > 0, 'search results', 20000, L('list.searchResults'), SEL.row);
    const results = await browser.execute((s) => [...document.querySelectorAll(s)].map((r) => (r.innerText || '').replace(/\s*\n\s*/g, ' | ').slice(0, 90)), SEL.row);
    console.log('[footage] results:', JSON.stringify(results));
    await take.hold(1500);
    await take.click(SEL.row, 'result-1');
    await take.waitFor((empty) => !document.body.innerText.includes(empty), 'message to open', 10000, L('viewer.selectEmailRead'));
    await take.hold(1500);

    const rec = await take.stop();
    console.log('[footage] pointer after the take:', pointer());
    console.log('[footage] load:\n' + await load());
    writeFileSync(join(OUT_DIR, 's4-search.results.json'), JSON.stringify({ query: QUERY, results }, null, 2));
    if (rec.delivered < 10) throw new Error(`only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  });
});
