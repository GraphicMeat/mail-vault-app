// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsWindow } from '../useSettingsWindow';

afterEach(cleanup);

describe('useSettingsWindow', () => {
  it('does not mount Settings before it is opened or when minimizing a closed window', () => {
    const { result } = renderHook(() => useSettingsWindow());
    expect(result.current.isMounted).toBe(false);
    expect(result.current.request).toBeNull();
    act(() => result.current.minimizeSettings());
    expect(result.current.status).toBe('closed');
    expect(result.current.request).toBeNull();
  });

  it('keeps the same session mounted while minimized and restores it from a generic opener', () => {
    const { result } = renderHook(() => useSettingsWindow());
    act(() => result.current.openSettings({ tab: 'accounts', accountId: 'studio', section: 'connection' }));
    const request = result.current.request;
    act(() => result.current.minimizeSettings());
    expect(result.current.isMounted).toBe(true);
    expect(result.current.isOpen).toBe(false);
    expect(result.current.isMinimized).toBe(true);
    expect(result.current.request).toBe(request);
    act(() => result.current.openSettings());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.isMinimized).toBe(false);
    expect(result.current.request).toBe(request);
  });

  it('leaves an already open session intact when Settings is opened again without a destination', () => {
    const { result } = renderHook(() => useSettingsWindow());
    act(() => result.current.openSettings());
    const request = result.current.request;
    expect(request).toMatchObject({ tab: null, accountId: null, section: null });
    act(() => result.current.openSettings());
    expect(result.current.request).toBe(request);
  });

  it('opens explicit destinations as new sessions even when that same destination was requested before', () => {
    const { result } = renderHook(() => useSettingsWindow());
    const destination = { tab: 'accounts', accountId: 'studio', section: 'connection' };
    act(() => result.current.openSettings(destination));
    const firstRequest = result.current.request;
    act(() => result.current.minimizeSettings());
    act(() => result.current.openSettings(destination));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.request).toMatchObject(destination);
    expect(result.current.request.id).not.toBe(firstRequest.id);
  });

  it('clears account and subsection targeting when opening a different page', () => {
    const { result } = renderHook(() => useSettingsWindow());
    act(() => result.current.openSettings({ tab: 'accounts', accountId: 'studio', section: 'connection' }));
    act(() => result.current.openSettings({ tab: 'billing' }));
    expect(result.current.request).toMatchObject({ tab: 'billing', accountId: null, section: null });
  });

  it('fully closes a minimized session, and a later generic open starts fresh', () => {
    const { result } = renderHook(() => useSettingsWindow());
    act(() => result.current.openSettings({ tab: 'accounts', accountId: 'studio', section: 'advanced' }));
    const firstId = result.current.request.id;
    act(() => result.current.minimizeSettings());
    act(() => result.current.closeSettings());
    expect(result.current.status).toBe('closed');
    expect(result.current.isMounted).toBe(false);
    expect(result.current.request).toBeNull();
    act(() => result.current.openSettings());
    expect(result.current.request).toMatchObject({ tab: null, accountId: null, section: null });
    expect(result.current.request.id).not.toBe(firstId);
  });
});
