import { describe, it, expect } from 'vitest';
import { onboardingSteps } from '../../src/components/onboarding/steps.js';

describe('onboarding step list', () => {
  it('walks a first run through all eight steps', () => {
    expect(onboardingSteps(0)).toEqual(
      ['splash', 'storage', 'account', 'appearance', 'defaultMail', 'free', 'premium', 'cta'],
    );
  });

  // Where the mail goes is asked before any account exists, so nothing is
  // written to the default location first.
  it('asks where mail is stored right before the account step', () => {
    const steps = onboardingSteps(0);
    expect(steps.indexOf('storage')).toBe(steps.indexOf('account') - 1);
  });

  // Reset replays the tour for someone who already has mail set up; asking for
  // credentials again would be nonsense.
  // Storage goes with it: the mail already lives somewhere, and moving it is
  // a Settings job, not a tour step.
  it('skips credentials and storage on a replay', () => {
    expect(onboardingSteps(2)).toEqual(
      ['splash', 'appearance', 'defaultMail', 'free', 'premium', 'cta'],
    );
  });

  it('always starts at the splash, so a replay can change the language', () => {
    expect(onboardingSteps(0)[0]).toBe('splash');
    expect(onboardingSteps(9)[0]).toBe('splash');
  });
});
