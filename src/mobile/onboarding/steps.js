/**
 * The phone's tour, as the desktop's (`src/components/onboarding/steps.js`) without the
 * computer-only steps (storage, appearance, default mail app). A replay for someone who already
 * has accounts drops the account step and keeps everything else, so nothing extra is stored to
 * tell a first run from a replay.
 */
export function mobileOnboardingSteps(accountCount) {
  return ['language', ...(accountCount > 0 ? [] : ['account']), 'free', 'premium', 'done'];
}

/**
 * Whether the launch shows the tour, from the engine's `mobile.settings.get` answer and the
 * number of accounts: `'show'` on a fresh install (tour never finished, no accounts);
 * `'markComplete'` on an install that already has accounts (it never sees the tour, and is marked
 * done so a later removal of every account does not bring it up); `'none'` otherwise, and when
 * the settings could not be read (the add-account screen is the safe start).
 */
export function onboardingGate(settings, accountCount) {
  if (!settings || settings.onboardingComplete === true) return 'none';
  return accountCount > 0 ? 'markComplete' : 'show';
}
