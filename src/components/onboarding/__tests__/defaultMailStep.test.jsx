// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { onboardingSteps } from '../steps.js';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

import { DefaultMailStep } from '../DefaultMailStep';

beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve({ isDefault: false, canSet: true, hint: '' }));
});
afterEach(cleanup);

describe('default mail app onboarding step', () => {
  it('comes after the appearance step on a first run and on a replay', () => {
    for (const accountCount of [0, 2]) {
      const steps = onboardingSteps(accountCount);
      expect(steps).toContain('defaultMail');
      expect(steps.indexOf('defaultMail')).toBe(steps.indexOf('appearance') + 1);
    }
  });

  it('lets someone move on without making MailVault the default', async () => {
    // Nobody is trapped on this screen: it is an offer, not a gate.
    const onContinue = vi.fn();
    render(<DefaultMailStep onContinue={onContinue} />);

    fireEvent.click(await screen.findByTestId('onboarding-continue'));

    expect(onContinue).toHaveBeenCalled();
  });

  it('carries the same row the settings page uses', async () => {
    render(<DefaultMailStep onContinue={() => {}} />);

    expect(await screen.findByTestId('default-mail-state')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('mailto_default_status');
  });
});
