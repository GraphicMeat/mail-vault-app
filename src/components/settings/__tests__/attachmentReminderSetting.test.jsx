// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BehaviorSettings } from '../BehaviorSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
vi.mock('../DefaultMailApp', () => ({ DefaultMailApp: () => null }));
afterEach(() => { cleanup(); useSettingsStore.setState({ attachmentReminder: true, billingProfile: null }); });

it('lets a Premium user turn the attachment reminder off, on by default', () => {
  useSettingsStore.setState({ billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' } });
  render(<BehaviorSettings />);
  expect(useSettingsStore.getState().attachmentReminder).toBe(true);

  fireEvent.click(screen.getByTestId('toggle-attachment-reminder'));
  expect(useSettingsStore.getState().attachmentReminder).toBe(false);
});

it('shows the reminder as Premium without a subscription', () => {
  render(<BehaviorSettings />);
  expect(screen.queryByTestId('toggle-attachment-reminder')).toBeNull();
  expect(screen.getByText('Attachment reminder')).toBeTruthy();
});
