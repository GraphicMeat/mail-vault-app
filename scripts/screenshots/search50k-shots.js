/**
 * Two shots of the app running on a 50,000-message vault, for the "search
 * 50,000 emails in milliseconds" articles:
 *
 *   search-50k-index    Settings > Storage > Search index, once the build is done
 *   search-50k-results  the query `invoice` over the whole vault
 *
 *   SHOTS_SEARCH50K=1 SHOTS_CORPUS_DIR=<dir written by search50kCorpus.mjs> \
 *     npx wdio run wdio.screenshots.conf.js
 *
 * Same two rules as shots.js: every shot asserts the state it photographs, and
 * a shot that cannot reach it is SKIPPED and logged, never faked. Nothing here
 * hardcodes a number the shot is meant to *report* — the counts are read off the
 * screen, asserted structurally (index complete, results capped below the real
 * match count) and printed as `[fact] …` lines for whoever writes the caption.
 * The corpus is one language by design (the query and the planted rates are the
 * claim); only the app chrome is localized.
 */

import { waitForApp, waitForEmails, openSettings, closeSettings } from '../../tests/e2e/helpers.js';
import { capture } from './capture.js';
import { raiseWindow } from './window.js';
import { makeLabels } from './labels.js';
import { appCode } from './locales.js';

const L = makeLabels(appCode(process.env.SHOTS_LOCALE || 'en'));
const QUERY = 'invoice';
const CARD = '#settings-search-index';

const clickTestId = (id) => browser.execute((t) => {
  const el = document.querySelector(`[data-testid="${t}"]`);
  if (!el || el.offsetHeight === 0 || el.disabled) return false;
  el.click();
  return true;
}, id);

const clickByText = (text) => browser.execute((t) => {
  for (const el of document.querySelectorAll('button')) {
    if (el.offsetHeight > 0 && (el.textContent || '').trim().startsWith(t)) { el.click(); return true; }
  }
  return false;
}, text);

/** The integers in a string, whatever the locale's grouping does to them. */
const numbers = (s) => (s.match(/\d[\d.,   ]*/g) || [])
  .map((n) => Number(n.replace(/\D/g, '')));

const probe = () => browser.execute((card) => {
  const vis = (el) => !!el && el.offsetHeight > 0;
  const text = (sel) => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    theme: document.documentElement.getAttribute('data-theme') || '',
    settings: vis(document.querySelector('[data-testid="settings-page"]')),
    settingsPage: document.querySelector('[data-testid="settings-content"]')?.dataset.page || '',
    listTitle: text('[data-testid="mailbox-title"]'),
    searchInput: vis(document.querySelector('[data-testid="mail-search-input"]')),
    rows: document.querySelectorAll('[data-testid="email-row"]').length,
    indexStatus: vis(document.querySelector('[data-testid="search-index-status"]')) ? text('[data-testid="search-index-status"]') : '',
    indexBusy: !!document.querySelector(`${card} [role="progressbar"]`),
    capped: text('[data-testid="search-index-capped"]'),
    building: text('[data-testid="search-index-building"]'),
    found: text('#mail-search-panel') + ' ' + text('.mt-2.text-xs'),
    // What the store holds behind the header, for a run that cannot reach its state.
    store: (() => {
      const st = window.__SEARCH_STORE__?.getState?.();
      if (!st) return null;
      const byFolder = {};
      for (const r of st.searchResults || []) byFolder[r.vaultDir || '?'] = (byFolder[r.vaultDir || '?'] || 0) + 1;
      return { coverage: st.searchIndexCoverage || null, byFolder, filters: st.searchFilters };
    })(),
  };
}, CARD);

async function expectState(pred, description, timeout = 15000) {
  let last = {};
  try {
    await browser.waitUntil(async () => { last = await probe(); return pred(last); }, { timeout, interval: 500 });
  } catch {
    throw new Error(`${description} — saw ${JSON.stringify(last)}`);
  }
  return last;
}

async function shot(name, settle = 900) {
  await browser.pause(settle);
  console.log(`[state] ${name}`, JSON.stringify(await probe()));
  await browser.execute(() => {
    const el = document.activeElement;
    if (el && el !== document.body && !/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) el.blur();
  });
  await browser.pause(150);
  capture(name);
}

async function step(name, fn, settle) {
  const only = (process.env.SHOTS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (only.length && !only.includes(name)) return;
  try {
    await fn();
    await shot(name, settle);
  } catch (e) {
    console.error(`[shot] SKIPPED ${name}: ${e.message}`);
  }
}

/** The work account's INBOX. Search runs from the account's own mailbox view. */
async function openWorkInbox() {
  await closeSettings();
  await browser.pause(500);
  const email = browser.demoAccounts[0].email;
  await browser.execute((mail) => {
    document.querySelector(`.sidebar-account-open[aria-label*="${mail}"]`)?.click();
  }, email);
  await browser.pause(900);
  await browser.execute(() => {
    document.querySelector('[data-testid="folder-row"][data-path="INBOX"]')?.click();
  });
  await browser.pause(900);
}


/**
 * Settings > Storage with the Search index card scrolled to the middle, once the
 * card says the build is finished. Returns the settled probe.
 *
 * Self-contained on purpose: SHOTS_ONLY skips step bodies, and a search photographed
 * while the index is still building shows a partial count with no cap line.
 */
async function finishedIndexCard() {
  await openSettings();
  await browser.pause(500);
  if (!(await clickByText(L('settings.tab.storage')))) throw new Error('storage tab not found');
  // The build is a background job in the daemon: wait for the card to say it
  // is finished, not for a fixed time. Numerically — the card formats its
  // counts with the system locale, and the size with its own unit.
  await expectState((p) => {
    if (!p.settings || p.settingsPage !== 'storage' || !p.indexStatus || p.indexBusy) return false;
    const [indexed, total] = numbers(p.indexStatus);
    return total >= 50000 && indexed === total;
  }, 'search index card not showing a finished 50,000-message index', 300000);
  // The demo accounts are still caching their own mail into the vault, so
  // the total can move after the first finished read. Take the reading only
  // once it has stopped moving.
  await browser.pause(6000);
  const settled = await probe();
  const [indexed, total] = numbers(settled.indexStatus);
  if (total !== 50000 || indexed !== total || settled.indexBusy) {
    throw new Error(`index card does not read exactly 50,000 / 50,000: "${settled.indexStatus}"`);
  }
  await browser.execute(() => document.activeElement?.blur?.());
  await browser.execute((card) => {
    document.querySelector(card)?.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, CARD);
  return settled;
}

describe('MailVault 50k search screenshots', function () {
  this.timeout(900000);

  before(async function () {
    await waitForApp();
    console.log('[shots] window:', await raiseWindow());
    await browser.pause(1500);
    await waitForEmails();
    await browser.pause(2500);
  });

  it('captures the set', async function () {
    await step('search-50k-index', async () => {
      const s = await finishedIndexCard();
      console.log(`[fact] index card: "${s.indexStatus}"`);
    }, 1200);

    await step('search-50k-results', async () => {
      await finishedIndexCard();
      await openWorkInbox();
      await expectState((p) => p.rows > 0 && !p.settings, 'not back on the work inbox');
      if (!(await clickTestId('mail-search-toggle'))) throw new Error('search toggle not found');
      await expectState((p) => p.searchInput, 'search panel did not open');
      // The vault's folders are not the inbox: search defaults to the open
      // folder, so scope it to every folder the way a user would (Filters >
      // Folder > All folders), then fold the dropdown away before the shot.
      if (!(await clickTestId('search-filters-toggle'))) throw new Error('filters toggle not found');
      await browser.pause(500);
      const scoped = await browser.execute(() => {
        const el = document.querySelector('[data-testid="search-folder-scope"]');
        if (!el || el.offsetHeight === 0) return false;
        // WebDriver's own select handling never reaches React's onChange.
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'all');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      });
      if (!scoped) throw new Error('folder scope select not found');
      await browser.pause(400);
      await clickTestId('search-filters-toggle');
      await browser.pause(400);
      await browser.execute((q) => {
        const input = document.querySelector('[data-testid="mail-search-input"]');
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, QUERY);
      await browser.pause(900);
      const submitted = await browser.execute(() => {
        const btn = document.querySelector('#mail-search-panel button[type="submit"]');
        if (!btn || btn.offsetHeight === 0) return false;
        btn.click();
        return true;
      });
      if (!submitted) await browser.keys(['Enter']);
      // Capped: the header says the list is the newest N of M matches, so the
      // matched count is on screen. No `building` line: the index is complete.
      const s = await expectState((p) => p.listTitle === L('list.searchResults') && p.rows > 0 && p.capped && !p.building,
        'indexed results header (with the capped-count line) missing', 60000);
      // Word order differs by language ("newest 500 of 2528" / "2528件のうち500件"),
      // so read the two numbers by size, not by position.
      const [shown, matched] = numbers(s.capped).sort((a, b) => a - b);
      if (!(matched > shown)) throw new Error(`capped line is not "newest N of M": "${s.capped}"`);
      console.log(`[fact] results: "${s.capped}"`);
      await browser.pause(800);
    });
  });
});
