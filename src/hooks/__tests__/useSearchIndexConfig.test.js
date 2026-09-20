// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

const configure = vi.fn();
let reconnect = null;
vi.mock('../../services/searchIndex', () => ({
  configure: (...args) => configure(...args),
  onDaemonReconnected: async (cb) => { reconnect = cb; return () => { reconnect = null; }; },
}));

import { effectiveSearchIndexConfig, useSearchIndexConfig } from '../useSearchIndexConfig.js';
import { useSettingsStore } from '../../stores/settingsStore';

const premium = { billingProfile: { hasSubscription: true, premiumAccess: true } };
const free = { billingProfile: null };

// Settings hydrate through a Promise; the hook waits for that on purpose.
beforeAll(async () => {
  await vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true));
  configure.mockResolvedValue(true); // default: every push succeeds unless a test overrides it
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  configure.mockReset().mockResolvedValue(true);
});

describe('effectiveSearchIndexConfig', () => {
  it('bodies follow the toggle for everyone', () => {
    expect(effectiveSearchIndexConfig({ ...free, searchIndexBodies: false, searchIndexAttachments: true, searchIndexImageText: true }, { isMac: true }).bodies).toBe(false);
    expect(effectiveSearchIndexConfig({ ...free, searchIndexBodies: true }, { isMac: true }).bodies).toBe(true);
  });
  it('attachments and image text need premium, image text needs a Mac', () => {
    const on = { searchIndexBodies: true, searchIndexAttachments: true, searchIndexImageText: true };
    expect(effectiveSearchIndexConfig({ ...free, ...on }, { isMac: true })).toEqual({ enabled: true, bodies: true, attachments: false, imageText: false });
    expect(effectiveSearchIndexConfig({ ...premium, ...on }, { isMac: true })).toEqual({ enabled: true, bodies: true, attachments: true, imageText: true });
    expect(effectiveSearchIndexConfig({ ...premium, ...on }, { isMac: false })).toEqual({ enabled: true, bodies: true, attachments: true, imageText: false });
    expect(effectiveSearchIndexConfig({ ...premium, ...on, searchIndexAttachments: false }, { isMac: true })).toEqual({ enabled: true, bodies: true, attachments: false, imageText: false });
  });
  it('sends enabled:false once the index is switched off', () => {
    expect(effectiveSearchIndexConfig({ ...free, searchIndexEnabled: false, searchIndexBodies: true }, { isMac: true }).enabled).toBe(false);
    expect(effectiveSearchIndexConfig({ ...free, searchIndexBodies: true }, { isMac: true }).enabled).toBe(true);
  });
});

describe('useSearchIndexConfig', () => {
  it('pushes the config once, again only when it changes', () => {
    useSettingsStore.setState({ searchIndexBodies: true, searchIndexEnabled: true, billingProfile: null });
    renderHook(() => useSearchIndexConfig());
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenLastCalledWith({ enabled: true, bodies: true, attachments: false, imageText: false });

    act(() => useSettingsStore.setState({ sendDelay: 30 }));
    expect(configure).toHaveBeenCalledTimes(1);

    act(() => useSettingsStore.getState().setSearchIndexBodies(false));
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenLastCalledWith({ enabled: true, bodies: false, attachments: false, imageText: false });
  });

  it('pushes nothing before settings hydrate, then the hydrated config exactly once', () => {
    let finishHydration = null;
    const hasHydrated = vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(false);
    const onFinish = vi.spyOn(useSettingsStore.persist, 'onFinishHydration')
      .mockImplementation((cb) => { finishHydration = cb; return () => {}; });
    try {
      useSettingsStore.setState({ searchIndexBodies: true, searchIndexEnabled: true, billingProfile: null }); // the defaults, before disk answers
      renderHook(() => useSearchIndexConfig());
      act(() => useSettingsStore.setState({ sendDelay: 30 }));
      act(() => useSettingsStore.setState({ searchIndexBodies: false })); // the saved value arriving
      expect(configure).not.toHaveBeenCalled();

      hasHydrated.mockReturnValue(true);
      act(() => finishHydration(useSettingsStore.getState()));
      expect(configure).toHaveBeenCalledTimes(1);
      expect(configure).toHaveBeenLastCalledWith({ enabled: true, bodies: false, attachments: false, imageText: false });
    } finally {
      hasHydrated.mockRestore();
      onFinish.mockRestore();
    }
  });

  it('pushes the same config again when the daemon reconnects, because a new daemon starts unconfigured', async () => {
    useSettingsStore.setState({ searchIndexBodies: true, searchIndexEnabled: true, billingProfile: null });
    renderHook(() => useSearchIndexConfig());
    await vi.waitFor(() => expect(reconnect).toBeTypeOf('function'));
    expect(configure).toHaveBeenCalledTimes(1);
    act(() => reconnect());
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenLastCalledWith({ enabled: true, bodies: true, attachments: false, imageText: false });
    cleanup();
    expect(reconnect).toBeNull();
  });

  it('retries a failed push without waiting for another store or reconnect event', async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ searchIndexBodies: true, searchIndexEnabled: true, billingProfile: null });
    configure.mockResolvedValueOnce(false).mockResolvedValue(true);
    renderHook(() => useSearchIndexConfig());
    await act(async () => { await Promise.resolve(); });
    expect(configure).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenLastCalledWith({ enabled: true, bodies: true, attachments: false, imageText: false });

    await vi.advanceTimersByTimeAsync(5000);
    expect(configure).toHaveBeenCalledTimes(2);
  });
});
