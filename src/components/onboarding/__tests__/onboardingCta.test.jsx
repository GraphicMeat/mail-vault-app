// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useMailStore } from '../../../stores/mailStore';
import { setLocale, t } from '../../../i18n/index.js';

// The thank-you step itself is under test, so only the steps before it are stubbed.
vi.mock('../Splash', () => ({ Splash: () => null }));
vi.mock('../StorageStep', () => ({ StorageStep: () => null }));
vi.mock('../AccountStep', () => ({ AccountStep: () => null }));
vi.mock('../AppearanceStep', () => ({ AppearanceStep: () => null }));
vi.mock('../DefaultMailStep', () => ({ DefaultMailStep: () => null }));
vi.mock('../FreeFeatures', () => ({ FreeFeatures: () => null }));
vi.mock('../PremiumGallery', () => ({ PremiumGallery: () => null }));

const { Onboarding } = await import('../../Onboarding');
const { UpgradeCta } = await import('../UpgradeCta');

const ACCOUNT = { id: 'a1', email: 'first@example.com' };

// A replay (accounts present) resumed at the thank-you step.
function renderCta({ accounts = [ACCOUNT], billingProfile = null } = {}) {
  useMailStore.setState({ accounts });
  useSettingsStore.setState({ onboardingSkippedAt: 'cta', billingProfile });
  const onComplete = vi.fn();
  render(<Onboarding onComplete={onComplete} />);
  return onComplete;
}

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  await setLocale('en');
});
afterEach(() => { cleanup(); useMailStore.setState({ accounts: [] }); });

describe('onboarding thank-you', () => {
  it('centres the thank-you in its own step class', () => {
    renderCta();
    expect(document.querySelector('.onboarding-step.onboarding-step-cta')).toBeTruthy();
  });

  it('See Premium asks for Billing before the arrival, Continue with Free does not', () => {
    const onComplete = renderCta();
    fireEvent.click(screen.getByTestId('onboarding-upgrade'));
    expect(onComplete).toHaveBeenCalledWith({ openBilling: true });
    expect(useSettingsStore.getState().onboardingComplete).toBe(true);
    cleanup();

    const onFree = renderCta();
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(onFree).toHaveBeenCalledWith({ openBilling: false });
  });

  it('a subscriber gets a single Continue', () => {
    const onComplete = renderCta({ billingProfile: { premiumAccess: true, status: 'active', hasSubscription: true } });
    expect(screen.queryByTestId('onboarding-upgrade')).toBeNull();
    const only = screen.getByTestId('onboarding-skip');
    expect(only.textContent).toBe(t('common.continue'));
    fireEvent.click(only);
    expect(onComplete).toHaveBeenCalledWith({ openBilling: false });
  });

  it('with no account there is nothing to buy with: a single Continue', () => {
    renderCta({ accounts: [] });
    expect(screen.queryByTestId('onboarding-upgrade')).toBeNull();
    expect(screen.getByTestId('onboarding-skip').textContent).toBe(t('common.continue'));
  });
});

describe('UpgradeCta without an upgrade', () => {
  it('shows only Continue', () => {
    const onSkip = vi.fn();
    render(<UpgradeCta onSkip={onSkip} onOpenFaq={() => {}} />);
    expect(screen.queryByTestId('onboarding-upgrade')).toBeNull();
    expect(screen.getAllByRole('button').filter(b => b.dataset.testid?.startsWith('onboarding-'))
      .map(b => b.dataset.testid)).toEqual(['onboarding-skip', 'onboarding-faq']);
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
