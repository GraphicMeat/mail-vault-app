/**
 * Shared steps for the Linux menu bar specs (ui-linux-menu-bar*.test.js).
 *
 * WebDriver cannot see the GTK menu bar itself, but it sits in the same window
 * as the webview: shown, it takes its height from the page, so the page's
 * `innerHeight` is the observable. Hidden or never attached, the page gets it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './mockImap.js';
import { openSettings, clickSettingsNav } from './helpers.js';

/** The strip is ~25px in Yaru/Adwaita; anything under this is not it. */
export const MENU_BAR_MIN_HEIGHT = 15;

export const isLinux = () => browser.execute(() => /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent));

export const pageHeight = () => browser.execute(() => window.innerHeight);

/** Wait for the page height to settle on a value `accept` takes. */
export async function waitForPageHeight(accept, what) {
  let last;
  await browser.waitUntil(async () => accept(last = await pageHeight()), {
    timeout: 10_000,
    interval: 200,
    timeoutMsg: `Page height never ${what} (last ${last}px)`,
  });
  return last;
}

export async function openLayoutSettings() {
  await openSettings();
  await clickSettingsNav('Appearance');
  await clickSettingsNav('Layout');
  await browser.pause(300);
}

/** The Menu bar switch's state, or null when it is not rendered. */
export const menuBarSwitch = () => browser.execute(() => {
  const toggle = document.querySelector('[data-testid="show-menu-bar"]');
  return toggle && toggle.offsetHeight > 0 ? toggle.getAttribute('aria-checked') === 'true' : null;
});

export async function clickMenuBarSwitch() {
  await browser.execute(() => {
    const toggle = document.querySelector('[data-testid="show-menu-bar"]');
    toggle.scrollIntoView({ behavior: 'instant', block: 'center' });
    toggle.click();
  });
}

/** The saved choice, off disk, where the shell reads it at the next launch. */
export function savedShowMenuBar() {
  try {
    const raw = readFileSync(join(appDataDir(browser.testDataDir), 'frontend-settings.json'), 'utf8');
    return JSON.parse(raw)['mailvault-settings']?.state?.showMenuBar;
  } catch {
    return undefined;
  }
}
