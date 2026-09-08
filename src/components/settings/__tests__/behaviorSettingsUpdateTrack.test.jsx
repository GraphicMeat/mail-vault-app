// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The row exists only where Sparkle does: a Developer ID macOS build. Linux has
// its own updater and the Mac App Store build has none, so the flag has to be
// swappable between the two cases in this file — hence the getter.
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

  it('is hidden in the App Store build, which updates through the App Store', async () => {
    buildFlags.IS_APPSTORE_BUILD = true;

    render(<BehaviorSettings />);

    // Something else from this panel renders, so this is absence, not a blank page.
    await screen.findByTestId('after-delete-select');
    expect(screen.queryByTestId('update-track-select')).toBeNull();
  });
});
