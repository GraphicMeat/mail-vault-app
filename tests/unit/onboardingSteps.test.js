import { describe, it, expect } from 'vitest';
import { onboardingSteps } from '../../src/components/onboarding/steps.js';

describe('onboarding step list', () => {
  it('walks a first run through all seven steps', () => {
    expect(onboardingSteps(0)).toEqual(
      ['splash', 'account', 'appearance', 'defaultMail', 'free', 'premium', 'cta'],
    );
  });

  // Reset replays the tour for someone who already has mail set up; asking for
  // credentials again would be nonsense.
  it('skips credentials on a replay', () => {
    expect(onboardingSteps(2)).toEqual(
      ['splash', 'appearance', 'defaultMail', 'free', 'premium', 'cta'],
    );
  });

  it('always starts at the splash, so a replay can change the language', () => {
    expect(onboardingSteps(0)[0]).toBe('splash');
    expect(onboardingSteps(9)[0]).toBe('splash');
  });
});
