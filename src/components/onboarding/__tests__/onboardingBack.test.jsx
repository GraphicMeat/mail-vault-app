// src/components/onboarding/__tests__/onboardingBack.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { onboardingSteps } from '../steps.js';
import { Onboarding } from '../../Onboarding';

// The step components pull in stores, screenshots and framer-motion. The flow
// under test is the shell's — which step is showing and how the back control
// moves between them — so the steps are stubbed down to their testid and their
// one outgoing call.
vi.mock('../Splash', () => ({
  Splash: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>splash</button>,
}));
vi.mock('../StorageStep', () => ({
  StorageStep: ({ onContinue, onBusyChange }) => (
    <>
      <button data-testid="go" onClick={onContinue}>storage</button>
      <button data-testid="storage-busy" onClick={() => onBusyChange?.(true)}>busy</button>
      <button data-testid="storage-idle" onClick={() => onBusyChange?.(false)}>idle</button>
    </>
  ),
}));
vi.mock('../AccountStep', () => ({
  AccountStep: ({ onSkip }) => <button data-testid="go" onClick={onSkip}>account</button>,
}));
vi.mock('../AppearanceStep', () => ({
  AppearanceStep: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>appearance</button>,
}));
vi.mock('../FreeFeatures', () => ({
  FreeFeatures: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>free</button>,
}));
vi.mock('../PremiumGallery', () => ({ PremiumGallery: () => <div>premium</div> }));
vi.mock('../UpgradeCta', () => ({
  UpgradeCta: ({ onSkip }) => <button data-testid="finish" onClick={onSkip}>cta</button>,
}));

const setOnboardingComplete = vi.fn();
let accounts = [];

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (sel) => sel({ setOnboardingComplete }),
  hasPremiumAccess: () => false,
}));
vi.mock('../../../stores/accountStore', () => ({
  useAccountStore: (sel) => sel({ accounts }),
}));

beforeEach(() => { accounts = []; setOnboardingComplete.mockClear(); });
afterEach(cleanup);

// The shell stamps the live step on its own root as `onboarding-<step>`, which
// is also the selector the e2e harness keys on.
const STEPS = onboardingSteps(0);
const currentStep = () =>
  STEPS.find(s => document.querySelector(`[data-testid="onboarding-${s}"]`));

// The stubbed steps advance via their own button; the premium step's Continue
// belongs to the shell, so it is the one real control in this file.
const advance = () => {
  const el = screen.queryByTestId('go') || screen.getByTestId('onboarding-continue');
  fireEvent.click(el);
};

describe('onboarding back button', () => {
  it('announces completion only when the final choice is made', () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    for (const _ of STEPS.slice(1)) advance();
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('finish'));
    expect(setOnboardingComplete).toHaveBeenCalledWith(true);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('is absent on the first step — there is nothing behind it', () => {
    render(<Onboarding />);
    expect(currentStep()).toBe('splash');
    expect(screen.queryByTestId('onboarding-back')).toBeNull();
  });

  it('appears once the flow has moved and returns to the previous step', () => {
    render(<Onboarding />);
    advance();
    expect(currentStep()).toBe('storage');

    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(currentStep()).toBe('splash');
    expect(screen.queryByTestId('onboarding-back')).toBeNull();
  });

  it('walks the whole flow backwards without falling off the start', () => {
    render(<Onboarding />);
    for (const _ of STEPS.slice(1)) advance();
    expect(currentStep()).toBe('cta');

    // One more press than there are steps: the first index must clamp, not go
    // negative and render nothing.
    for (let i = 0; i < onboardingSteps(0).length + 1; i++) {
      const back = screen.queryByTestId('onboarding-back');
      if (back) fireEvent.click(back);
    }
    expect(currentStep()).toBe('splash');
  });

  // A replay skips the storage and credentials steps, so back from
  // `appearance` has to land on `splash`, not on a step this run never had.
  it('skips the step the replay skipped', () => {
    accounts = [{ id: 'a1' }];
    render(<Onboarding />);
    advance();
    expect(currentStep()).toBe('appearance');

    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(currentStep()).toBe('splash');
  });

  it('does not finish onboarding by going back', () => {
    render(<Onboarding />);
    advance();
    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(setOnboardingComplete).not.toHaveBeenCalled();
  });

  // Continue already waits for a vault move; Back and Skip tour are the other
  // ways off the step, and leaving mid-copy adds an account while the mail is
  // between two folders.
  it('holds Back and Skip tour while the storage step moves the vault', () => {
    render(<Onboarding />);
    advance();
    expect(currentStep()).toBe('storage');
    fireEvent.click(screen.getByTestId('storage-busy'));
    expect(screen.getByTestId('onboarding-back').disabled).toBe(true);
    expect(screen.getByTestId('onboarding-skip').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('storage-idle'));
    expect(screen.getByTestId('onboarding-back').disabled).toBe(false);
    expect(screen.getByTestId('onboarding-skip').disabled).toBe(false);
  });
});
