// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The row exists on a Developer ID macOS build (Sparkle) and on Windows
// (tauri-plugin-updater). The Mac App Store build has none, so the flag has to
// be swappable between the cases in this file — hence the getter.
const buildFlags = { IS_APPSTORE_BUILD: false };
vi.mock('../../../utils/buildFlags', () => ({
  get IS_APPSTORE_BUILD() { return buildFlags.IS_APPSTORE_BUILD; },
}));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const getVersion = vi.fn();
vi.mock('@tauri-apps/api/app', () => ({ getVersion: (...a) => getVersion(...a) }));

import { BehaviorSettings } from '../BehaviorSettings';
import { useSettingsStore } from '../../../stores/settingsStore';

beforeEach(() => {
  vi.clearAllMocks();
  buildFlags.IS_APPSTORE_BUILD = false;
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh)', configurable: true });
  getVersion.mockResolvedValue('2.12.0');
  // DefaultMailApp asks the backend on mount; nothing here reads its answer.
  invoke.mockResolvedValue(undefined);
  useSettingsStore.setState({ updateTrack: null });
});
afterEach(cleanup);

describe('Update track setting', () => {
  it('sends the chosen track to the backend and remembers it', async () => {
    render(<BehaviorSettings />);

    const select = await screen.findByTestId('update-track-select');
    // No saved choice on a stable build: stable, without anything written yet.
    expect(select.value).toBe('stable');

    fireEvent.change(select, { target: { value: 'nightly' } });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_update_track', { track: 'nightly' });
    });
    // Rust re-reads this file at the next launch, so the store is the record.
    expect(useSettingsStore.getState().updateTrack).toBe('nightly');
  });

  it('shows on Windows, where Check for updates asks the Rust updater', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });

    render(<BehaviorSettings />);

    fireEvent.click(await screen.findByTestId('update-track-check-now'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('check_for_updates_now');
    });
  });

  it('is hidden on Linux, which has no nightlies', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64)', configurable: true });

    render(<BehaviorSettings />);

    await screen.findByTestId('after-delete-select');
    expect(screen.queryByTestId('update-track-select')).toBeNull();
  });

  it('is hidden in the App Store build, which updates through the App Store', async () => {
    buildFlags.IS_APPSTORE_BUILD = true;

    render(<BehaviorSettings />);

    // Something else from this panel renders, so this is absence, not a blank page.
    await screen.findByTestId('after-delete-select');
    expect(screen.queryByTestId('update-track-select')).toBeNull();
  });
});
