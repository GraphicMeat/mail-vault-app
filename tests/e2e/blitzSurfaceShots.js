/**
 * Screenshots for the Blitz surface specs: one native window capture per
 * surface and mode, written to SHOT_DIR (the job script tars that directory to
 * stdout; the minijob clone is deleted afterwards). Best effort by design: a
 * missed shot is logged and never fails a spec, the assertions are the gate.
 *
 * `screencapture -l` of the live window (not WebDriver's takeScreenshot, which
 * draws an SVG foreignObject of the DOM and leaves cross-origin tiles blank).
 * macOS only; elsewhere every call logs "not captured".
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { windowId } from '../../scripts/screenshots/capture.js';
import { raiseWindow } from '../../scripts/screenshots/window.js';

process.env.SHOTS_APP_BINARY ||= process.env.TAURI_APP_BINARY || resolve(process.cwd(), 'target/debug/mailvault');

export const SHOT_DIR = process.env.MV_BLITZ_SURFACES_OUT || join(tmpdir(), 'blitz-d-surfaces');
const IS_MAC = process.platform === 'darwin';
const note = (tag, v) => console.log(`[blitzsurf] ${tag} ${JSON.stringify(v)}`);

/** The window the next capture will find: the biggest on screen, so the main window is sized up front. */
export const raise = (w = 1280, h = 900) => raiseWindow(w, h).catch((e) => String(e));

export function windowShot(name) {
  if (!IS_MAC) { note('shot-skipped', { name, why: 'not macOS' }); return false; }
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = join(SHOT_DIR, `${name}.png`);
    execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', windowId(), file]);
    note('shot', { name, file });
    return true;
  } catch (e) {
    note('shot-failed', { name, error: String(e?.message || e) });
    return false;
  }
}

/** A canvas the page rendered, as a PNG (base64 from the page). */
export function writeShot(name, base64) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = join(SHOT_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(base64, 'base64'));
    note('shot', { name, file });
    return true;
  } catch (e) {
    note('shot-failed', { name, error: String(e?.message || e) });
    return false;
  }
}

/**
 * The app theme and the mail theme, for one mode. The app theme goes through the
 * sidebar's own toggle (the theme store is not on window); the mail theme is the
 * emailViewerTheme setting.
 */
export const setMode = async (mode) => {
  await browser.execute((m) => {
    window.__SETTINGS_STORE__.setState({ emailViewerTheme: m });
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    if (cur === m) return;
    [...document.querySelectorAll('button')].find(b => /^switch to (light|dark) mode$/i.test((b.getAttribute('aria-label') || b.title || '').trim()))?.click();
  }, mode);
  await browser.waitUntil(() => browser.execute((m) => (document.documentElement.getAttribute('data-theme') || 'dark') === m, mode),
    { timeout: 5000, interval: 100, timeoutMsg: `the app did not switch to ${mode}` });
};

export const readMode = () => browser.execute(() => ({
  emailViewerTheme: window.__SETTINGS_STORE__.getState().emailViewerTheme,
  chrome: document.documentElement.getAttribute('data-theme') || 'dark',
}));

export const restoreMode = async (prev) => {
  await setMode(prev.chrome);
  await browser.execute((p) => window.__SETTINGS_STORE__.setState({ emailViewerTheme: p.emailViewerTheme }), prev);
};

/**
 * Light then dark for one on-screen surface. `ready()` resolves once the surface
 * has repainted for the mode (the doc re-opens when the theme flips).
 */
export async function shootModes(name, ready) {
  let prev = null;
  try {
    prev = await readMode();
    for (const mode of ['light', 'dark']) {
      await setMode(mode);
      await browser.pause(500); // the doc re-opens a tick after the flip
      await ready();
      await browser.pause(900);
      windowShot(`${name}-${mode}`);
    }
  } catch (e) {
    note('shot-failed', { name, error: String(e?.message || e) });
  } finally {
    if (prev) { try { await restoreMode(prev); } catch { /* app gone */ } }
  }
}
