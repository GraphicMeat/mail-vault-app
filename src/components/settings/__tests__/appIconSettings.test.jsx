// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AppIconSettings } from '../AppIconSettings';
import { useSettingsStore, _mergePersistedSettings } from '../../../stores/settingsStore';
const apply = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/appIcon', () => ({
  APP_ICONS: { purple: '/purple.png', teal: '/teal.png' },
  normalizeAppIcon: value => value === 'teal' ? 'teal' : 'purple',
  applyAppIcon: apply,
}));
beforeEach(() => { apply.mockReset(); useSettingsStore.setState({ appIcon: 'purple' }); });
afterEach(cleanup);
it('saves a successful teal change and keeps both choices available', async () => {
  render(<AppIconSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
  await waitFor(() => expect(useSettingsStore.getState().appIcon).toBe('teal'));
  expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Purple' })).toBeTruthy();
});
it('keeps the previous selection when native application fails', async () => {
  apply.mockRejectedValue(new Error('failed'));
  render(<AppIconSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
  await screen.findByRole('alert');
  expect(useSettingsStore.getState().appIcon).toBe('purple');
});
it('restores teal from saved settings and defaults old settings to purple', () => {
  const current = useSettingsStore.getState();
  expect(_mergePersistedSettings({ appIcon: 'teal' }, current).appIcon).toBe('teal');
  expect(_mergePersistedSettings({}, current).appIcon).toBe('purple');
  current.setAppIcon('unknown');
  expect(useSettingsStore.getState().appIcon).toBe('purple');
});
