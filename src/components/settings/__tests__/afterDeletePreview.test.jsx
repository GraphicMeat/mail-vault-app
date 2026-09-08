// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BehaviorSettings } from '../BehaviorSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
vi.mock('../DefaultMailApp', () => ({ DefaultMailApp: () => null }));
afterEach(cleanup);
it('keeps the after-deletion example next to the preference in Settings', () => {
  useSettingsStore.setState({ afterDeleteSelect: 'none' });
  render(<BehaviorSettings />);
  const sample = screen.getByRole('figure', { name: 'After Deleting' });
  expect(within(sample).getByText('Select an email to read')).toBeTruthy();
  fireEvent.change(screen.getByTestId('after-delete-select'), { target: { value: 'next' } });
  expect(useSettingsStore.getState().afterDeleteSelect).toBe('next');
  expect(within(sample).getByText('MeatPad')).toBeTruthy();
});
