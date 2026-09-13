// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

const configure = vi.fn();
vi.mock('../../services/searchIndex', () => ({ configure: (...args) => configure(...args) }));

import { effectiveSearchIndexConfig, useSearchIndexConfig } from '../useSearchIndexConfig.js';
import { useSettingsStore } from '../../stores/settingsStore';

const premium = { billingProfile: { hasSubscription: true, premiumAccess: true } };
const free = { billingProfile: null };

// Settings hydrate through a Promise; the hook waits for that on purpose.
beforeAll(() => vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true)));
afterEach(() => { cleanup(); configure.mockReset(); });

describe('effectiveSearchIndexConfig', () => {
  it('bodies follow the toggle for everyone', () => {
    expect(effectiveSearchIndexConfig({ ...free, searchIndexBodies: false, searchIndexAttachments: true, searchIndexImageText: true }, { isMac: true }).bodies).toBe(false);
    expect(effectiveSearchIndexConfig({ ...free, searchIndexBodies: true }, { isMac: true }).bodies).toBe(true);
  });
  it('attachments and image text need premium, image text needs a Mac', () => {
    const on = { searchIndexBodies: true, searchIndexAttachments: true, searchIndexImageText: true };
    expect(effectiveSearchIndexConfig({ ...free, ...on }, { isMac: true })).toEqual({ bodies: true, attachments: false, imageText: false });
    expect(effectiveSearchIndexConfig({ ...premium, ...on }, { isMac: true })).toEqual({ bodies: true, attachments: true, imageText: true });
    expect(effectiveSearchIndexConfig({ ...premium, ...on }, { isMac: false })).toEqual({ bodies: true, attachments: true, imageText: false });
    expect(effectiveSearchIndexConfig({ ...premium, ...on, searchIndexAttachments: false }, { isMac: true })).toEqual({ bodies: true, attachments: false, imageText: false });
  });
});

describe('useSearchIndexConfig', () => {
  it('pushes the config once, again only when it changes', () => {
    useSettingsStore.setState({ searchIndexBodies: true, billingProfile: null });
    renderHook(() => useSearchIndexConfig());
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenLastCalledWith({ bodies: true, attachments: false, imageText: false });

    act(() => useSettingsStore.setState({ sendDelay: 30 }));
    expect(configure).toHaveBeenCalledTimes(1);

    act(() => useSettingsStore.getState().setSearchIndexBodies(false));
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenLastCalledWith({ bodies: false, attachments: false, imageText: false });
  });

  it('pushes nothing before settings hydrate, then the hydrated config exactly once', () => {
    let finishHydration = null;
    const hasHydrated = vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(false);
    const onFinish = vi.spyOn(useSettingsStore.persist, 'onFinishHydration')
      .mockImplementation((cb) => { finishHydration = cb; return () => {}; });
    try {
      useSettingsStore.setState({ searchIndexBodies: true, billingProfile: null }); // the defaults, before disk answers
      renderHook(() => useSearchIndexConfig());
      act(() => useSettingsStore.setState({ sendDelay: 30 }));
      act(() => useSettingsStore.setState({ searchIndexBodies: false })); // the saved value arriving
      expect(configure).not.toHaveBeenCalled();

      hasHydrated.mockReturnValue(true);
      act(() => finishHydration(useSettingsStore.getState()));
      expect(configure).toHaveBeenCalledTimes(1);
      expect(configure).toHaveBeenLastCalledWith({ bodies: false, attachments: false, imageText: false });
    } finally {
      hasHydrated.mockRestore();
      onFinish.mockRestore();
    }
  });
});
