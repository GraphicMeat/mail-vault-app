// @vitest-environment jsdom
//
// The Rust side emits `update-available` after every check (the startup
// probe and the menu's manual check). The hook decides what the window does
// with it: show the update dialog, honour a snooze or a skipped version on an
// automatic check, or, right after a restart taken to finish a failed
// install, hand the already-downloaded update straight to Sparkle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const harness = { listeners: new Map(), checkForUpdates: vi.fn() };
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    harness.listeners.set(name, cb);
    return () => harness.listeners.delete(name);
  },
}));
vi.mock('tauri-plugin-sparkle-updater-api', () => ({ checkForUpdates: (...a) => harness.checkForUpdates(...a) }));

const { useUpdateAvailable } = await import('../useUpdateAvailable');
const { useSettingsStore } = await import('../../stores/settingsStore');

const emit = async (payload) => {
  await act(async () => { await harness.listeners.get('update-available')?.({ payload }); });
};
const auto = { version: '2.19.1', notes: '', currentVersion: '2.15.0', isManualCheck: false };

let snapshot;
beforeEach(() => {
  harness.listeners.clear();
  harness.checkForUpdates.mockReset();
  harness.checkForUpdates.mockResolvedValue(undefined);
  snapshot = useSettingsStore.getState();
  useSettingsStore.setState({ updateSnoozeUntil: null, updateSkippedVersion: null, updateResumeAfterRestart: false });
});
afterEach(() => useSettingsStore.setState(snapshot, true));

describe('useUpdateAvailable', () => {
  it('shows an automatic check', async () => {
    const { result } = renderHook(() => useUpdateAvailable());
    await act(async () => {});
    await emit(auto);
    expect(result.current.updateInfo).toEqual(auto);
    expect(harness.checkForUpdates).not.toHaveBeenCalled();
  });

  it('keeps a snoozed or skipped version quiet on an automatic check, not on a manual one', async () => {
    useSettingsStore.setState({ updateSkippedVersion: '2.19.1' });
    const { result } = renderHook(() => useUpdateAvailable());
    await act(async () => {});
    await emit(auto);
    expect(result.current.updateInfo).toBeNull();
    await emit({ ...auto, isManualCheck: true });
    expect(result.current.updateInfo?.version).toBe('2.19.1');
    expect(useSettingsStore.getState().updateSkippedVersion).toBeNull();
  });

  it('after a restart taken to finish an install, hands the update to Sparkle instead of asking again', async () => {
    useSettingsStore.setState({ updateResumeAfterRestart: true });
    const { result } = renderHook(() => useUpdateAvailable());
    await act(async () => {});
    await emit(auto);
    expect(harness.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result.current.updateInfo).toBeNull();
    // Once only: the flag is spent, the next check is an ordinary one.
    expect(useSettingsStore.getState().updateResumeAfterRestart).toBe(false);
    await emit(auto);
    expect(harness.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result.current.updateInfo).toEqual(auto);
  });

  it('a stale resume flag with nothing to install is simply spent', async () => {
    // The flag outlived its update (installed by hand, or the feed moved on):
    // the first check after that clears it and shows the dialog as usual on
    // the next one. Sparkle with no cached download just checks the feed.
    useSettingsStore.setState({ updateResumeAfterRestart: true, updateSkippedVersion: '2.19.1' });
    const { result } = renderHook(() => useUpdateAvailable());
    await act(async () => {});
    await emit(auto);
    expect(harness.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().updateResumeAfterRestart).toBe(false);
    expect(result.current.updateInfo).toBeNull();
  });
});
