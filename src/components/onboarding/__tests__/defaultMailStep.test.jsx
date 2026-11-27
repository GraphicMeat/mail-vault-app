// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { onboardingSteps } from '../steps.js';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

import { DefaultMailStep } from '../DefaultMailStep';
import { useSettingsStore } from '../../../stores/settingsStore';
import { previewRows } from '../../../data/previewMail.js';

beforeEach(() => {
  useSettingsStore.setState({ composeOpenMode: 'app', confirmBeforeDelete: true, afterDeleteSelect: 'none' });
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

  it('asks where Compose opens, with the same row as Settings', async () => {
    render(<DefaultMailStep onContinue={() => {}} />);
    expect(await screen.findByTestId('compose-open-mode')).toBeTruthy();
  });

  // The step filled two thirds of the window and showed none of its choices
  // working. It now carries the Make it yours sample window, in the same box,
  // and the window shows whatever was chosen last.
  describe('sample window', () => {
    const radio = name => screen.getByRole('radio', { name });

    it('opens Compose inside the app, or in a window of its own', () => {
      render(<DefaultMailStep onContinue={() => {}} />);
      expect(screen.getByTestId('appearance-preview')).toBeTruthy();
      fireEvent.click(radio('In a new window'));
      expect(screen.getByTestId('preview-compose').dataset.mode).toBe('window');
      fireEvent.click(radio('In the app'));
      expect(screen.getByTestId('preview-compose').dataset.mode).toBe('app');
    });

    it('asks before deleting, or deletes right away', () => {
      render(<DefaultMailStep onContinue={() => {}} />);
      fireEvent.click(radio('Delete right away'));
      expect(screen.queryByTestId('preview-delete-confirm')).toBeNull();
      fireEvent.click(radio('Ask every time'));
      expect(screen.getByTestId('preview-delete-confirm').textContent).toContain('Delete email?');
    });

    it('opens what the after-delete choice says', () => {
      const rows = previewRows();
      render(<DefaultMailStep onContinue={() => {}} />);
      const opened = () => screen.getByTestId('preview-pane-viewer').textContent;
      fireEvent.click(radio('Select the next email'));
      expect(opened()).toContain(rows[2].subject);
      fireEvent.click(radio('Select the previous email'));
      expect(opened()).toContain(rows[0].subject);
      fireEvent.click(radio('Select nothing'));
      expect(opened()).toContain('Select an email to read');
      expect(screen.getByTestId('preview-deleted-row')).toBeTruthy();
    });
  });
});
