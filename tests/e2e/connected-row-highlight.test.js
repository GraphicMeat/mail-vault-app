/**
 * E2E Test: the two ways the list marks what you are reading
 *
 * `emailRowHighlight` is an Appearance setting with two values. `hover` is the
 * default and what the app has always done: rows light up under the pointer and
 * the open one carries the accent tint. `selection` turns that around — the
 * pointer does nothing, the open row is filled with a neutral grey, and the
 * rest of its conversation takes a lighter grey.
 *
 * Fixture: FRAGMENTED_SUBJECT, whose conversation has THREE messages in INBOX.
 * The spec runs in flat thread mode so all three are separate rows: that is the
 * only view where a sibling ground is visible next to the open row, and it is
 * also the mode that skips thread-building entirely unless the marking mode
 * asks for it — so a green sibling assertion here proves that gate too.
 *
 * Colours are compared against probe elements carrying the same utility
 * classes, never against hardcoded hex: the tokens are theme-dependent and a
 * literal would only assert the theme the runner happens to be in.
 *
 * The pointer half is asserted through the CLASS, not through a real hover:
 * `tauri-wd`'s `moveTo` does not put WKWebView into a `:hover` state at all.
 * Control, 2026-09-07: a moveTo onto a row in the DEFAULT mode left
 * `row.matches(':hover')` false, `[data-testid="email-row"]:hover` unmatched
 * and the background unchanged — the mode that is supposed to light up. So a
 * red here would mean the driver changed, not the app.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { FRAGMENTED_SUBJECT } from './mockImap.js';

/** Resolve a set of background utilities to the colours this theme paints. */
const probeColours = () => browser.execute(() => {
  const out = {};
  for (const cls of ['bg-mail-accent-tint', 'bg-mail-row-selected', 'bg-mail-row-related']) {
    const el = document.createElement('div');
    el.className = cls;
    document.body.appendChild(el);
    out[cls] = getComputedStyle(el).backgroundColor;
    el.remove();
  }
  return out;
});

/** Every visible row carrying the fixture's subject, in list order. */
const threadRows = () => browser.execute((subj) =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj))
    .map(r => ({
      uid: r.getAttribute('data-uid'),
      bg: getComputedStyle(r).backgroundColor,
      // The class is the contract for the pointer: `hover:` compiles to a rule
      // no computed style can report until a real pointer is over the row.
      reactsToPointer: /(^|\s)hover:bg-mail-surface-hover(\s|$)/.test(r.className),
      border: getComputedStyle(r).borderLeftWidth,
    })), FRAGMENTED_SUBJECT);

/**
 * WebDriver never reaches React's onChange, so a setting is written through the
 * store the app itself exposes under VITE_E2E.
 */
const setSettings = (patch) => browser.execute((p) => {
  window.__SETTINGS_STORE__.setState(p);
}, patch);

/** Open the row at `index` among the fixture's rows, then let the list settle. */
async function openRow(index) {
  const clicked = await browser.execute((subj, i) => {
    const rows = [...document.querySelectorAll('[data-testid="email-row"]')]
      .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj));
    if (!rows[i]) return false;
    rows[i].click();
    return true;
  }, FRAGMENTED_SUBJECT, index);
  expect(clicked).toBe(true);
  // `.virtual-row` transitions background-color; give it more than that.
  await browser.pause(600);
}

describe('Email row highlighting', function () {
  this.timeout(90_000);

  let colours;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Flat mode draws every message of the conversation as its own row.
    await setSettings({ threadMode: 'flat', emailRowHighlight: 'hover' });
    await browser.pause(800);
    colours = await probeColours();
  });

  after(async function () {
    await setSettings({ threadMode: 'grouped', emailRowHighlight: 'hover' });
  });

  it('draws the conversation as separate rows in flat mode', async function () {
    const rows = await threadRows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  describe('the default, pointer-led mode', function () {
    before(async function () {
      await setSettings({ emailRowHighlight: 'hover' });
      await browser.pause(400);
      await openRow(1);
    });

    it('gives the open row the accent tint and its left border', async function () {
      const rows = await threadRows();
      const open = rows.filter(r => r.bg === colours['bg-mail-accent-tint']);
      expect(open.length).toBe(1);
      expect(open[0].border).toBe('2px');
    });

    it('leaves every other row reacting to the pointer', async function () {
      const rows = await threadRows();
      for (const r of rows.filter(r => r.bg !== colours['bg-mail-accent-tint'])) {
        expect(r.reactsToPointer).toBe(true);
      }
    });

    it('marks nothing else in the conversation', async function () {
      const rows = await threadRows();
      expect(rows.some(r => r.bg === colours['bg-mail-row-related'])).toBe(false);
    });
  });

  describe('the marking mode', function () {
    before(async function () {
      await setSettings({ emailRowHighlight: 'selection' });
      // Flat mode builds its thread model only for this setting; that runs on a
      // timeout after the setting lands.
      await browser.pause(1200);
      await openRow(1);
    });

    it('fills the open row with the marking grey, and drops the border', async function () {
      const rows = await threadRows();
      const open = rows.filter(r => r.bg === colours['bg-mail-row-selected']);
      expect(open.length).toBe(1);
      expect(open[0].border).toBe('0px');
    });

    it('gives the rest of the conversation the lighter grey', async function () {
      const rows = await threadRows();
      const related = rows.filter(r => r.bg === colours['bg-mail-row-related']);
      expect(related.length).toBeGreaterThanOrEqual(2);
      // The open row is not its own sibling.
      expect(related.some(r => r.bg === colours['bg-mail-row-selected'])).toBe(false);
    });

    it('stops every row reacting to the pointer', async function () {
      const rows = await threadRows();
      for (const r of rows) expect(r.reactsToPointer).toBe(false);
    });

  });

  describe('switching back', function () {
    // Deliberately the last block: every spec file shares one HOME, so the
    // marking mode must not outlive this file's own assertions.
    it('restores the accent tint without a reload', async function () {
      await setSettings({ emailRowHighlight: 'hover' });
      await browser.pause(600);
      const rows = await threadRows();
      expect(rows.some(r => r.bg === colours['bg-mail-accent-tint'])).toBe(true);
      expect(rows.some(r => r.bg === colours['bg-mail-row-selected'])).toBe(false);
      expect(rows.some(r => r.bg === colours['bg-mail-row-related'])).toBe(false);
    });
  });
});
