/**
 * E2E: does WebKit actually MARK a misspelled word?
 *
 * `connected-compose-spellcheck.test.js` next door asserts `el.spellcheck` —
 * the IDL getter — in five cases, and every one of them was green for the
 * whole period the feature was dead on macOS: the getter answers "would this
 * element be checked", which stays true with the engine's checker switched
 * off. The only thing that separates a working spell checker from a broken one
 * is the red line under the word, and that line is a native document marker:
 * it is not in the DOM, has no CSS, and no `browser.execute` can see it.
 *
 * So this spec looks at pixels. It never asserts an absolute colour count —
 * a theme, an unread dot or a warning banner could be red too. It asserts a
 * DIFFERENCE between two screenshots that are identical in every other
 * respect, which is what makes the squiggle the only thing that can explain
 * it:
 *
 *   1. same window, same spellcheck state, correct words vs misspelled words
 *   2. same window, same misspelled words, spellcheck on vs off
 *
 * Both directions have to move, or the checker is not running.
 *
 * WHY THIS IS `visual-*` AND NOT `connected-*`. It cannot run in CI. Capturing
 * the window needs Screen Recording, and making the window WORTH capturing
 * needs `scripts/screenshots/prepare-build.sh` — an occluded WKWebView paints
 * nothing at all on a display-less runner, and the first two attempts at this
 * spec photographed an empty dark rectangle while reporting a confident zero.
 * So it lives in the `local-manual` suite with the other pixel specs:
 *
 *   scripts/screenshots/prepare-build.sh
 *   cargo build -p mailvault --features webdriver
 *   npx wdio run wdio.conf.js --spec tests/e2e/visual-compose-squiggle.test.js
 *   scripts/screenshots/prepare-build.sh --revert
 */

import { PNG } from 'pngjs';   // ponytail: hoisted by @wdio/visual-service; no new dependency
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// The window-id helper the marketing screenshots already use. It pins the
// capture to ONE process, which matters here: other sessions run their own
// MailVault on this mini and the name-only match takes the largest window.
import { windowId } from '../../scripts/screenshots/capture.js';
import { raiseWindow } from '../../scripts/screenshots/window.js';

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import {
  EDITOR,
  typeInBody,
  clickToolbar,
  closeComposeHard,
  openComposeFresh,
  settingsCall,
} from './composeHelpers.js';

/**
 * The FIRST word is the one that gets marked, so make it long.
 *
 * Measured on the mini: typing this sentence underlines `Ths` and nothing else,
 * whether it arrives in one `insertText` or word by word — about 74 red pixels,
 * which is a thin thing to hang an assertion on. A long first word draws a long
 * line.
 */
const MISSPELLED = 'Deliberatly mispeled wrds heer.';

/**
 * How much of the window is red.
 *
 * Deliberately loose — macOS antialiases the dotted marker, so a strict
 * "pure red" test would count almost none of it. Constant red elsewhere in the
 * window cancels out because every assertion below is a difference between two
 * shots of the same screen.
 */
/**
 * Rows to ignore at the top of the capture: the titlebar.
 *
 * The close button is RED, and it greys out the moment the window is not the
 * frontmost one. That blob is 740 red pixels over 28 rows at y=18..45, and it
 * is bigger than the squiggle — an earlier cut of this spec "proved" the
 * toolbar clears the underline when all it had photographed was the app losing
 * focus between two shots.
 */
const TITLEBAR = 80;

function measure(file) {
  const png = PNG.sync.read(readFileSync(file));
  const d = png.data;
  const seen = new Set();
  const rows = new Array(png.height).fill(0);
  let red = 0;
  for (let y = TITLEBAR; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 90 && r - Math.max(g, b) > 40) { red++; rows[y]++; }
      // Colour variety is the cheap proof that the webview actually drew.
      if (seen.size <= 400) seen.add((r << 16) | (g << 8) | b);
    }
  }
  return { red, rows, distinct: seen.size };
}

/**
 * What separates a squiggle from "some red turned up".
 *
 * A spelling marker is a few pixels tall and as wide as one word, so the red it
 * adds lands in a HANDFUL OF CONSECUTIVE ROWS. Measured here: 466 red pixels
 * across exactly four rows, y=849..852, with zero on those rows when checking
 * was off. Anything spread over the window — a themed control, a badge, glyph
 * antialiasing after a text change — fails the row test even when the total
 * looks convincing, which an earlier cut of this spec did.
 */
function band(before, after) {
  const gained = after.rows.map((n, y) => n - before.rows[y]);
  const lit = gained.filter((n) => n > 5);
  return { rows: lit.length, total: lit.reduce((sum, n) => sum + n, 0) };
}

describe('Compose Squiggle (pixels)', function () {
  this.timeout(180_000);

  let luke;
  const shots = [];

  /**
   * Photograph the app window and count red, keeping the PNG for a human.
   *
   * NOT `browser.takeScreenshot()`. On this display-less runner WebDriver's
   * screenshot returns a frozen frame: 18 captures across two compose windows
   * and a toggle came back byte-for-byte identical, so the first version of
   * this spec could not have failed for a real reason. `screencapture -l`
   * reads the window's own backing store and sees the live pixels.
   */
  function redNow(tag) {
    const out = join(browser.testDataDir, `squiggle-${tag}.png`);
    execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', windowId(), out]);
    const m = measure(out);
    shots.push(`${tag}=${m.red}/${m.distinct}c`);
    // An unpainted webview is a flat rectangle. Two of those compare equal and
    // the spec would pass its "no red here either" half while proving nothing.
    expect(m.distinct).toBeGreaterThan(200);
    return m;
  }

  /**
   * Type word by word, not sentence at once.
   *
   * `typeInBody` is one `execCommand('insertText')` for the whole string, and
   * WebKit closes only ONE word boundary for it: the first run of this spec
   * marked `Ths` and left `sentnce`, `deliberatly` and `wrng` clean, for a
   * signal of 74 red pixels that could just as well have been two sentences
   * shaped differently. A space per word is what a keyboard does, and it marks
   * every word.
   */
  async function typeWords(text) {
    for (const word of text.split(' ')) await typeInBody(`${word} `);
  }

  /**
   * WebKit marks on a typing command and repaints lazily; leaving the editable
   * and coming back is what forces the paint — the same nudge the toolbar's
   * own toggle does.
   */
  async function settle() {
    await browser.execute((sel) => {
      const el = document.querySelector(sel);
      el?.blur();
      el?.focus();
    }, EDITOR);
    // 2500, not 1200. WebKit's checker is ASYNCHRONOUS: at 1200 ms only the
    // first word of the sentence has been marked, which looked like a product
    // defect ("MailVault only underlines one word") until a bare
    // contenteditable beside the editor showed the same partial state at the
    // same moment and the full four underlines a second later.
    await browser.pause(2500);
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    [luke] = browser.mockAccounts || [];
    expect(luke?.id).toBeDefined();

    // Pin the capture to the binary this run launched — see the import note.
    process.env.SHOTS_APP_BINARY = process.env.TAURI_APP_BINARY
      || resolve(process.cwd(), 'target/debug/mailvault');

    // A locked Mac composites no window content at all: `screencapture` hands
    // back the desktop picture, the webview never paints, and every count below
    // is a confident zero about nothing. Name it here or spend an hour on it.
    const locked = execFileSync('/bin/sh', ['-c',
      'ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw -o - - 2>/dev/null || echo false',
    ], { encoding: 'utf-8' }).trim();
    expect(locked).toBe('false');   // unlock the runner's screen and re-run

    // Pin the window on top and focus it. Without this the webview is occluded
    // and stops painting: `screencapture` then writes a window with NO CONTENT
    // and every red count below is 0 for a reason that has nothing to do with
    // spelling. Needs the capability prepare-build.sh writes.
    const raised = await raiseWindow(1200, 800);
    expect(raised).toBe('ok');
    await browser.pause(1500);

    // First call compiles the swift helper and proves a window of OUR app is
    // on screen; the id is what every capture below is pinned to.
    expect(windowId()).toMatch(/^\d+$/);

    // Without Screen Recording every capture is a blank frame and every
    // assertion below passes or fails for a reason that has nothing to do with
    // spelling. Refuse to run rather than report a number nobody can trust.
    let permission = 'denied';
    try {
      permission = execFileSync(
        join(process.cwd(), 'scripts/screenshots/.windowid'), ['--check-permission'],
        { encoding: 'utf-8' },
      ).trim();
    } catch { /* exits 2 when denied */ }
    expect(permission).toBe('granted');

    await settingsCall('setSpellcheckEnabled', true);
  });

  afterEach(async function () {
    await closeComposeHard();
    await settingsCall('setSpellcheckEnabled', true);
  });

  after(async function () {
    console.log(`[squiggle] red pixel counts: ${shots.join(' ')}`);
    await switchToFolder(luke.email, 'INBOX');
  });

  it('paints red under a misspelled word, and does not when checking is off', async function () {
    // The SAME sentence both times. An earlier cut compared a correct sentence
    // against a misspelled one and called the difference the squiggle — but
    // macOS subpixel-antialiases glyph edges into faintly coloured fringes, so
    // different letters alone moved the count by 486 while exactly one word was
    // underlined. Identical text, checking off then on, is the only comparison
    // where the marker is the sole variable.
    await settingsCall('setSpellcheckEnabled', false);
    await openComposeFresh();
    await typeWords(MISSPELLED);
    await settle();
    const clean = redNow('unchecked');

    await closeComposeHard();
    await settingsCall('setSpellcheckEnabled', true);
    await openComposeFresh();
    await typeWords(MISSPELLED);
    await settle();

    let marked = band(clean, clean);
    try {
      await browser.waitUntil(async () => {
        marked = band(clean, redNow('misspelled'));
        return marked.total > 40 && marked.rows <= 8;
      }, { timeout: 15_000, interval: 2_000 });
    } catch {
      /* fall through to the assertions, which report the numbers */
    }

    expect(marked.total).toBeGreaterThan(40);   // there is new red
    expect(marked.rows).toBeGreaterThan(0);
    expect(marked.rows).toBeLessThanOrEqual(8); // and it is a LINE, not a wash
  });

  it('stops painting it when the toolbar turns checking off', async function () {
    await openComposeFresh();
    await typeWords(MISSPELLED);
    await settle();
    const on = redNow('toggle-on');

    // The handler blurs and refocuses; WebKit clears the markers it drew.
    await clickToolbar('Spellcheck');
    await browser.pause(1200);

    let cleared = { rows: 0, total: 0 };
    try {
      await browser.waitUntil(async () => {
        cleared = band(redNow('toggle-off'), on);   // red the toggle took AWAY
        return cleared.total > 40;
      }, { timeout: 15_000, interval: 2_000 });
    } catch {
      /* fall through */
    }

    // Toggling AFTER the marker is drawn is a different claim from case 1, and
    // the changelog makes it in as many words: "Press it and the red underlines
    // stop". Photographed on the mini, they do not — the line under the word
    // survives the toggle, the blur/focus nudge included.
    expect(cleared.total).toBeGreaterThan(40);
    // Same shape test as case 1: what the toggle takes away has to be the LINE.
    expect(cleared.rows).toBeLessThanOrEqual(8);
  });

  it('and paints them again when it is turned back on', async function () {
    // The other half of what the toolbar promises. Turning checking back on
    // has to re-mark the words already written, not just the next ones — which
    // needs the same node rebuild, because a marker cannot be added to a text
    // node WebKit has already decided about either.
    await openComposeFresh();
    await typeWords(MISSPELLED);
    await settle();
    const marked = redNow('again-marked');

    await clickToolbar('Spellcheck');
    await browser.pause(2000);
    const off = redNow('again-off');
    expect(band(off, marked).total).toBeGreaterThan(40);   // it cleared

    await clickToolbar('Spellcheck');
    await settle();

    let back = { rows: 0, total: 0 };
    try {
      await browser.waitUntil(async () => {
        back = band(off, redNow('again-back'));
        return back.total > 40 && back.rows <= 8;
      }, { timeout: 15_000, interval: 2_000 });
    } catch { /* fall through to the assertions */ }

    expect(back.total).toBeGreaterThan(40);
    expect(back.rows).toBeLessThanOrEqual(8);
  });
});
