/**
 * The whole of the reset behaviour is this one conditional: a replay for
 * someone who already has accounts drops the storage and credentials steps and
 * keeps everything else, so no extra persisted field is needed to tell a first
 * run from a replay. Storage comes before the account so nothing is written to
 * the default location before the user has picked one.
 */
export function onboardingSteps(accountCount) {
  return [
    'splash',
    ...(accountCount > 0 ? [] : ['storage', 'account']),
    'appearance',
    'defaultMail',
    'free',
    'premium',
    'cta',
  ];
}
