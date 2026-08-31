/**
 * Captures the first-run tour, one shot per step.
 *
 *   SHOTS_ONBOARDING=1 npx wdio run wdio.screenshots.conf.js
 *   SHOTS_ONBOARDING=1 SHOTS_LOCALE=de npx wdio run wdio.screenshots.conf.js
 *
 * The marketing run (shots.js) seeds `onboardingComplete: true` and three
 * mailboxes, so it can never see this screen. This one seeds neither: no
 * account means `onboardingSteps()` returns all six steps rather than the
 * shortened replay, which is the flow a new install actually gets.
 *
 * Same rule as shots.js — every shot asserts the step it is about to
 * photograph, because `screencapture` will happily write a stale frame.
 */

import { capture } from './capture.js';
import { raiseWindow } from './window.js';
import { appCode } from './locales.js';

const LOCALE_DIR = process.env.SHOTS_LOCALE || 'en';
const APP_LOCALE = appCode(LOCALE_DIR);

const SETTLE = 1200; // the splash logo animates in over 0.7s + 0.5s delay

/** The step names src/components/onboarding/steps.js can return. */
const STEPS = ['splash', 'account', 'appearance', 'free', 'premium', 'cta'];

/** Which step the tour is showing — the wrapper carries `onboarding-<step>`. */
const currentStep = () => browser.execute((steps) => {
  for (const s of steps) {
    if (document.querySelector(`[data-testid="onboarding-${s}"]`)) return s;
  }
  return null;
}, STEPS);

const click = (testid) => browser.execute((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el || !el.offsetHeight) return false;
  el.click();
  return true;
}, testid);

async function waitForStep(name, timeout = 20000) {
  let seen = null;
  try {
    await browser.waitUntil(async () => {
      seen = await currentStep();
      return seen === name;
    }, { timeout, interval: 300 });
  } catch {
    throw new Error(`tour did not reach "${name}" — showing "${seen}"`);
  }
}

/**
 * Photograph the step the tour is on, then press the control that advances it.
 * A step that cannot be reached is reported and skipped, never faked.
 */
async function step(name, advanceTestId) {
  await waitForStep(name);
  await browser.pause(SETTLE);
  await browser.execute(() => {
    const el = document.activeElement;
    if (el && el !== document.body) el.blur();
  });
  capture(`onboarding-${name}`);
  if (advanceTestId && !(await click(advanceTestId))) {
    throw new Error(`${name}: ${advanceTestId} not found`);
  }
}

describe('MailVault onboarding screenshots', function () {
  before(async function () {
    // waitForApp() waits for the sidebar or the welcome screen; during the tour
    // there is neither, so wait on the tour itself.
    await browser.waitUntil(async () => (await currentStep()) !== null,
      { timeout: 30000, interval: 500, timeoutMsg: 'onboarding never rendered' });
    console.log('[shots] window:', await raiseWindow());
    await browser.pause(1500);
    console.log('[shots] locale:', LOCALE_DIR, APP_LOCALE, 'step:', await currentStep());
  });

  it('captures the tour', async function () {
    await step('splash', 'onboarding-continue');
    await step('account', 'onboarding-skip-account');
    await step('appearance', 'onboarding-continue');
    await step('free', 'onboarding-continue');
    await step('premium', 'onboarding-continue');
    await step('cta', null); // last screen: advancing it ends the tour
  });
});
