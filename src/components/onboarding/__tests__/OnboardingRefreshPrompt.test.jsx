// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { setLocale, t } from '../../../i18n/index.js';
import * as keychainSession from '../../../services/keychainSession';
import { OnboardingRefreshPrompt } from '../OnboardingRefreshPrompt';

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  // A legacy install has already finished the old flow.
  useSettingsStore.setState({ onboardingComplete: true });
  await setLocale('en');
  keychainSession.recordOutcome('granted');
});
afterEach(cleanup);

const prompt = () => screen.queryByRole('status', { name: t('onboarding.refreshTitle') });

describe('OnboardingRefreshPrompt', () => {
  it('shows once, even if the app closes before the user dismisses it', () => {
    const view = render(<StrictMode><OnboardingRefreshPrompt /></StrictMode>);
    expect(prompt()).not.toBeNull();
    expect(useSettingsStore.getState().appearanceOnboardingPromptSeen).toBe(true);
    view.unmount();
    render(<OnboardingRefreshPrompt />);
    expect(prompt()).toBeNull();
  });

  it('does not offer a replay to new users after they finish onboarding', () => {
    useSettingsStore.setState({ onboardingComplete: false });
    render(<OnboardingRefreshPrompt />);
    expect(prompt()).toBeNull();
    act(() => useSettingsStore.getState().setOnboardingComplete(true));
    expect(prompt()).toBeNull();
  });

  it('waits until the workspace is ready before consuming the invitation', () => {
    const view = render(<OnboardingRefreshPrompt ready={false} />);
    expect(prompt()).toBeNull();
    expect(useSettingsStore.getState().appearanceOnboardingPromptSeen).toBe(false);
    view.rerender(<OnboardingRefreshPrompt ready />);
    expect(prompt()).not.toBeNull();
  });

  it('waits for credential recovery before offering a tour', () => {
    keychainSession.recordOutcome('denied');
    render(<OnboardingRefreshPrompt />);
    expect(prompt()).toBeNull();
    expect(useSettingsStore.getState().appearanceOnboardingPromptSeen).toBe(false);
    act(() => keychainSession.recordOutcome('granted'));
    expect(prompt()).not.toBeNull();
  });

  it('restarts the existing flow without resetting preferences', async () => {
    useSettingsStore.setState({ sidebarLayout: 'split', viewStyle: 'chat' });
    render(<OnboardingRefreshPrompt />);
    fireEvent.click(screen.getByRole('button', { name: t('onboarding.refreshRestart') }));
    expect(useSettingsStore.getState()).toMatchObject({
      onboardingComplete: false,
      appearanceOnboardingPromptSeen: true,
      sidebarLayout: 'split',
      viewStyle: 'chat',
    });
    await waitFor(() => expect(prompt()).toBeNull());
  });

  it.each(['dismiss', 'close', 'escape'])('allows %s without restarting onboarding', async action => {
    render(<OnboardingRefreshPrompt />);
    if (action === 'escape') fireEvent.keyDown(prompt(), { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: t(action === 'close' ? 'common.close' : 'toast.dismiss') }));
    await waitFor(() => expect(prompt()).toBeNull());
    expect(useSettingsStore.getState().onboardingComplete).toBe(true);
  });

  it('keeps focus in the workspace when the invitation appears', () => {
    const view = render(<><button>Inbox</button><OnboardingRefreshPrompt ready={false} /></>);
    screen.getByRole('button', { name: 'Inbox' }).focus();
    view.rerender(<><button>Inbox</button><OnboardingRefreshPrompt ready /></>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inbox' }));
    expect(prompt()).not.toBeNull();
  });

  it('updates the visible copy when the language changes', async () => {
    render(<OnboardingRefreshPrompt />);
    const englishTitle = t('onboarding.refreshTitle');
    await act(async () => { await setLocale('de'); });
    expect(prompt()).not.toBeNull();
    expect(screen.queryByText(englishTitle)).toBeNull();
    expect(screen.getByRole('button', { name: t('onboarding.refreshRestart') })).toBeTruthy();
  });
});
