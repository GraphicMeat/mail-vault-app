// @vitest-environment jsdom
import React, { lazy, Suspense } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChunkErrorBoundary } from '../../ChunkErrorBoundary';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useThemeStore } from '../../../stores/themeStore';

// Exercise the same lazy entry as App. Do not mock General or Appearance:
// rendering those screens is the behavior this regression test protects.
const SettingsPage = lazy(() => import('../../SettingsPage').then(module => ({ default: module.SettingsPage })));
let media;
let mediaListeners;

beforeEach(() => {
  mediaListeners = new Set();
  media = {
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_, listener) => mediaListeners.add(listener)),
    removeEventListener: vi.fn((_, listener) => mediaListeners.delete(listener)),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  useMailStore.setState({ accounts: [], activeAccountId: null });
  useSettingsStore.setState({ viewStyle: 'list', layoutMode: 'three-column' });
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openSettings() {
  render(<ChunkErrorBoundary name="Settings"><Suspense fallback={<p>Loading settings</p>}>
    <SettingsPage onClose={() => {}} />
  </Suspense></ChunkErrorBoundary>);
  return screen.findByRole('heading', { name: 'Color & theme' }, { timeout: 5000 });
}

it('opens the complete default Settings screen and applies its palette controls', async () => {
  await openSettings();
  expect(screen.queryByRole('region', { name: 'Your workspace' })).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Graphite/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Light', exact: true }));
  expect(useThemeStore.getState()).toMatchObject({ palette: 'graphite', theme: 'light' });
  expect(screen.getByRole('heading', { name: 'Color & theme' })).toBeTruthy();
});

it('updates the narrow-window explanation when the window crosses the layout breakpoint', async () => {
  await openSettings();
  fireEvent.click(screen.getByRole('tab', { name: 'Layout', exact: true }));
  expect(screen.queryByText(/This window is too narrow/)).toBeNull();
  act(() => {
    media.matches = true;
    mediaListeners.forEach(listener => listener({ matches: true }));
  });
  expect(screen.getByText(/This window is too narrow/)).toBeTruthy();
  act(() => mediaListeners.forEach(listener => listener({ matches: false })));
  expect(screen.queryByText(/This window is too narrow/)).toBeNull();
});


it('keeps the simplified reading and formatting controls connected to saved preferences', async () => {
  await openSettings();
  const changes = [
    ['Colors', 'Email viewer theme', 'dark', 'emailViewerTheme'],
    ['Reading', 'Conversations', 'flat', 'threadMode'],
    ['Reading', 'Signature Display', 'always-show', 'signatureDisplay'],
    ['Date & time', 'Date Format', 'custom', 'dateFormat'],
    ['Date & time', 'Time Format', '24h', 'timeFormat'],
  ];
  for (const [section, name, value, key] of changes) {
    fireEvent.click(screen.getByRole('tab', { name: section, exact: true }));
    fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
    expect(useSettingsStore.getState()[key]).toBe(value);
  }
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom...' }), { target: { value: 'yyyy.MM.dd' } });
  expect(useSettingsStore.getState().customDateFormat).toBe('yyyy.MM.dd');
});
