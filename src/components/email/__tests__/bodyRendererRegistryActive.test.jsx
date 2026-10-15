// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  registerBodyRenderer, _resetBodyRenderersForTest, getActiveBodyRenderer, useActiveBodyRenderer,
} from '../bodyRendererRegistry';
import { useSettingsStore } from '../../../stores/settingsStore';

afterEach(() => { _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('active body renderer accessors', () => {
  it('is null on web, and null with nothing registered', () => {
    expect(getActiveBodyRenderer()).toBeNull();
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    expect(getActiveBodyRenderer()).toBeNull();
  });

  it('hands services the whole registered impl when its mode is on', () => {
    const impl = { Body: () => null, rasterize: async () => null, openWindow: async () => 'original-1' };
    registerBodyRenderer('blitz', impl);
    expect(getActiveBodyRenderer()).toBeNull();
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    expect(getActiveBodyRenderer()).toBe(impl);
  });

  it('the hook follows the setting both ways', () => {
    const impl = { Body: () => null };
    registerBodyRenderer('blitz', impl);
    const { result } = renderHook(() => useActiveBodyRenderer());
    expect(result.current).toBeNull();
    act(() => useSettingsStore.setState({ emailRenderer: 'blitz' }));
    expect(result.current).toBe(impl);
    act(() => useSettingsStore.setState({ emailRenderer: 'web' }));
    expect(result.current).toBeNull();
  });
});
