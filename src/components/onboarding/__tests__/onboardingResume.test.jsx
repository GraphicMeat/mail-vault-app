// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { setLocale } from '../../../i18n/index.js';
import * as keychainSession from '../../../services/keychainSession';
import { onboardingSteps } from '../steps.js';

// Same stubs as onboardingBack.test.jsx: the shell's flow is under test.
vi.mock('../Splash', () => ({ Splash: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>splash</button> }));
vi.mock('../AccountStep', () => ({ AccountStep: ({ onSkip }) => <button data-testid="go" onClick={onSkip}>account</button> }));
vi.mock('../AppearanceStep', () => ({ AppearanceStep: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>appearance</button> }));
vi.mock('../DefaultMailStep', () => ({ DefaultMailStep: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>defaultMail</button> }));
vi.mock('../FreeFeatures', () => ({ FreeFeatures: ({ onContinue }) => <button data-testid="go" onClick={onContinue}>free</button> }));
vi.mock('../PremiumGallery', () => ({ PremiumGallery: () => <div>premium</div> }));
vi.mock('../UpgradeCta', () => ({ UpgradeCta: ({ onSkip }) => <button data-testid="finish" onClick={onSkip}>cta</button> }));

const { Onboarding } = await import('../../Onboarding');
const { OnboardingResumePrompt } = await import('../OnboardingResumePrompt');

const STEPS = onboardingSteps(0);
const currentStep = () => STEPS.find(s => document.querySelector(`[data-testid="onboarding-${s}"]`));
const prompt = () => screen.queryByTestId('onboarding-resume-prompt');
const state = () => useSettingsStore.getState();

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  await setLocale('en');
  keychainSession.recordOutcome('granted');
});
afterEach(cleanup);

describe('skipping onboarding', () => {
  it('finishes the tour from any step and remembers where', () => {
    render(<Onboarding />);
    fireEvent.click(screen.getByTestId('go'));
    fireEvent.click(screen.getByTestId('go'));
    expect(currentStep()).toBe('appearance');
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(state().onboardingComplete).toBe(true);
    expect(state().onboardingSkippedAt).toBe('appearance');
    // Skipping must not also queue the "new appearance options" invitation.
    expect(state().appearanceOnboardingPromptSeen).toBe(true);
  });

  it('resumes at the skipped step, and finishing clears it', () => {
    act(() => state().skipOnboarding('free'));
    act(() => state().resumeOnboarding());
    render(<Onboarding />);
    expect(currentStep()).toBe('free');
    fireEvent.click(screen.getByTestId('go'));
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    fireEvent.click(screen.getByTestId('finish'));
    expect(state().onboardingComplete).toBe(true);
    expect(state().onboardingSkippedAt).toBe(null);
  });

  it('starts over when the skipped step no longer exists', () => {
    act(() => state().skipOnboarding('bogus'));
    act(() => state().resumeOnboarding());
    render(<Onboarding />);
    expect(currentStep()).toBe('splash');
  });

  it('offers no skip on the last step, where "Maybe later" already finishes', () => {
    act(() => state().skipOnboarding('cta'));
    act(() => state().resumeOnboarding());
    render(<Onboarding />);
    expect(currentStep()).toBe('cta');
    expect(screen.queryByTestId('onboarding-skip')).toBeNull();
  });
});

describe('OnboardingResumePrompt', () => {
  it('stays away for a finished tour', () => {
    act(() => state().setOnboardingComplete(true));
    render(<OnboardingResumePrompt />);
    expect(prompt()).toBeNull();
  });

  it('waits for the workspace', () => {
    act(() => state().skipOnboarding('appearance'));
    const view = render(<OnboardingResumePrompt ready={false} />);
    expect(prompt()).toBeNull();
    view.rerender(<OnboardingResumePrompt ready />);
    expect(prompt()).not.toBeNull();
  });

  it('carries on with the tour', () => {
    act(() => state().skipOnboarding('appearance'));
    render(<OnboardingResumePrompt />);
    fireEvent.click(screen.getByTestId('onboarding-resume'));
    expect(state().onboardingComplete).toBe(false);
    expect(state().onboardingSkippedAt).toBe('appearance');
  });

  it('comes back next launch when closed, never again when told so', async () => {
    act(() => state().skipOnboarding('appearance'));
    const first = render(<OnboardingResumePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(prompt()).toBeNull());
    expect(state().onboardingResumeDismissed).toBe(false);
    first.unmount();

    const second = render(<OnboardingResumePrompt />);
    expect(prompt()).not.toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-resume-never'));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(state().onboardingResumeDismissed).toBe(true);
    second.unmount();

    render(<OnboardingResumePrompt />);
    expect(prompt()).toBeNull();
  });
});
