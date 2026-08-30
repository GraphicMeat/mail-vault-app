/**
 * Native window capture for marketing screenshots.
 *
 * `screencapture -l <windowid>` grabs the real app window — rounded corners,
 * traffic lights, transparent surround — at the display's backing scale. On a
 * HiDPI screen that is 2x, which is the whole reason these run on the Mac mini
 * with the 5K panel rather than in a headless browser.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const HERE = import.meta.dirname;
const SWIFT_SRC = join(HERE, 'windowid.swift');
const SWIFT_BIN = join(HERE, '.windowid');

/**
 * English writes `website/screenshots/`; every other locale writes its own
 * subdirectory beside it, which is exactly where the website generator looks
 * for a localized shot before falling back to the English file.
 */
const LOCALE_DIR = process.env.SHOTS_LOCALE || 'en';

export const OUT_DIR = process.env.SHOTS_OUT
  || resolve(HERE, '../../website/screenshots', LOCALE_DIR === 'en' ? '' : LOCALE_DIR);

/** Compile the window-id helper once per run. */
function windowIdBinary() {
  if (!existsSync(SWIFT_BIN)) {
    execFileSync('swiftc', ['-O', SWIFT_SRC, '-o', SWIFT_BIN], { stdio: 'inherit' });
  }
  return SWIFT_BIN;
}

/**
 * CGWindowID of the app's main window. Retried: a window being moved, resized
 * or raised is briefly absent from the on-screen list, and one miss there would
 * cost a screenshot.
 */
export function windowId(appName = 'MailVault', attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return execFileSync(windowIdBinary(), [appName], { encoding: 'utf-8' }).trim();
    } catch (e) {
      lastError = e;
      execFileSync('sleep', ['0.5']);
    }
  }
  throw lastError;
}

/**
 * Capture the app window to `<OUT_DIR>/<name>.png`.
 * `-o` drops the drop shadow, matching the existing screenshot set.
 */
export function capture(name, { appName = 'MailVault' } = {}) {
  const out = join(OUT_DIR, `${name}.png`);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', windowId(appName), out]);
  console.log(`[shot] ${out}`);
  return out;
}
