/**
 * The whole of the reset behaviour is this one conditional: a replay for
 * someone who already has accounts drops the credentials step and keeps
 * everything else, so no extra persisted field is needed to tell a first run
 * from a replay.
 */
export function onboardingSteps(accountCount) {
  return [
    'splash',
    ...(accountCount > 0 ? [] : ['account']),
    'appearance',
    'free',
    'premium',
    'cta',
  ];
}
