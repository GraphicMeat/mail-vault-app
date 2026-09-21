// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BehaviorSettings } from '../BehaviorSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
vi.mock('../DefaultMailApp', () => ({ DefaultMailApp: () => null }));
afterEach(() => { cleanup(); useSettingsStore.setState({ confirmBeforeDelete: true }); });

it('offers the delete confirmation choice, asking by default', () => {
  render(<BehaviorSettings />);
  const select = screen.getByTestId('confirm-before-delete-select');
  expect(select.value).toBe('ask');
  expect(screen.getByText('Every delete asks for confirmation first.')).toBeTruthy();

  fireEvent.change(select, { target: { value: 'skip' } });
  expect(useSettingsStore.getState().confirmBeforeDelete).toBe(false);
  // The hint names the two deletes the choice deliberately does not reach.
  expect(screen.getByText(/Delete everywhere, and removing the only copy, still ask/)).toBeTruthy();
});
