// src/components/settings/__tests__/helpPremiumAndFaq.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
// Hoisted (not created inline inside the mock factory) so the reset test
// below can assert against the exact instance HelpSettings calls.
const setOnboardingComplete = vi.fn();
vi.mock('../../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (sel) => (typeof sel === 'function'
    ? sel({ setOnboardingComplete, language: 'de', localeEpoch: 0 })
    : { setOnboardingComplete }),
}));

import { HelpSettings } from '../HelpSettings';

afterEach(() => { cleanup(); openInBrowser.mockClear(); setOnboardingComplete.mockClear(); });

describe('Help: premium gallery and FAQ', () => {
  it('opens the FAQ in the running language', () => {
    render(<HelpSettings onClose={() => {}} onReportBug={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-link-faq').querySelector('button'));
    expect(openInBrowser).toHaveBeenCalledWith('https://mailvaultapp.com/de/faq.html');
  });

  it('reopens the premium gallery without a reset', () => {
    render(<HelpSettings onClose={() => {}} onReportBug={() => {}} />);
    expect(screen.queryByTestId('premium-detail')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-open-premium-gallery'));
    expect(screen.getByTestId('premium-detail')).toBeTruthy();
  });

  // Carried forward from review: the reset control's only guard used to be a
  // source-grep test (tests/unit/resetOnboarding.test.js) asserting the file
  // contains no `window.location.reload`. That stays green even if someone
  // deletes both the flag flip and the onClose call, so it does not prove the
  // button does anything. This is the behavioural companion — it renders the
  // real component, clicks the real control, and asserts the real calls.
  it('reset flips onboardingComplete to false and closes settings', () => {
    const onClose = vi.fn();
    render(<HelpSettings onClose={onClose} onReportBug={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-reset-onboarding').querySelector('button'));
    expect(setOnboardingComplete).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalled();
  });
});
