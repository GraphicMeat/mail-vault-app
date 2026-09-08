// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GeneralSettings } from '../GeneralSettings';
import { useSettingsStore, DEFAULT_SHORTCUTS } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

let settingsState;
beforeEach(() => {
  settingsState = useSettingsStore.getState();
  useSettingsStore.setState({ keyboardShortcuts: { ...DEFAULT_SHORTCUTS }, keyboardShortcutsEnabled: true });
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); useSettingsStore.setState(settingsState, true); vi.useRealTimers(); });
const binding = () => screen.getByRole('button', { name: new RegExp(`^${t('settings.shortcuts.nextEmail')}:`) });

it('cancels hidden shortcut recording and lets mail receive keys after minimizing', () => {
  const { rerender } = render(<GeneralSettings accounts={[]} initialSubTab="shortcuts" />);
  fireEvent.click(binding());
  expect(binding().getAttribute('aria-pressed')).toBe('true');
  rerender(<GeneralSettings accounts={[]} initialSubTab="shortcuts" active={false} />);
  const key = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  act(() => document.body.dispatchEvent(key));
  act(() => vi.advanceTimersByTime(600));
  expect(key.defaultPrevented).toBe(false);
  expect(useSettingsStore.getState().keyboardShortcuts.nextEmail).toBe(DEFAULT_SHORTCUTS.nextEmail);
  rerender(<GeneralSettings accounts={[]} initialSubTab="shortcuts" active />);
  expect(binding().getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(binding());
  fireEvent.keyDown(binding(), { key: 'x' });
  act(() => vi.advanceTimersByTime(600));
  expect(useSettingsStore.getState().keyboardShortcuts.nextEmail).toBe('x');
});

it('cancels a pending first key when Settings minimizes before the sequence timer expires', () => {
  const { rerender } = render(<GeneralSettings accounts={[]} initialSubTab="shortcuts" />);
  fireEvent.click(binding());
  fireEvent.keyDown(binding(), { key: 'x' });
  rerender(<GeneralSettings accounts={[]} initialSubTab="shortcuts" active={false} />);
  act(() => vi.advanceTimersByTime(600));
  expect(useSettingsStore.getState().keyboardShortcuts.nextEmail).toBe(DEFAULT_SHORTCUTS.nextEmail);
  rerender(<GeneralSettings accounts={[]} initialSubTab="shortcuts" active />);
  expect(binding().getAttribute('aria-pressed')).toBe('false');
});
