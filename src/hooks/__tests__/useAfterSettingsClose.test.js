// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAfterSettingsClose, useSettingsWindow } from '../useSettingsWindow';

function useBoth() {
  const win = useSettingsWindow();
  const after = useAfterSettingsClose(win.isMounted);
  return { ...win, after };
}

describe('useAfterSettingsClose', () => {
  it('runs once Settings opened in the same event closes, not on minimize', () => {
    const fn = vi.fn();
    const { result } = renderHook(useBoth);
    act(() => { result.current.after(fn); result.current.openSettings({ tab: 'billing' }); });
    expect(result.current.request.tab).toBe('billing');
    act(() => result.current.minimizeSettings());
    expect(fn).not.toHaveBeenCalled();
    act(() => result.current.closeSettings());
    expect(fn).toHaveBeenCalledOnce();
    act(() => { result.current.openSettings(); result.current.closeSettings(); });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('waits when Settings was already open and is only re-targeted', () => {
    const fn = vi.fn();
    const { result } = renderHook(useBoth);
    act(() => result.current.openSettings({ tab: 'help' }));
    act(() => { result.current.after(fn); result.current.openSettings({ tab: 'billing' }); });
    expect(fn).not.toHaveBeenCalled();
    act(() => result.current.closeSettings());
    expect(fn).toHaveBeenCalledOnce();
  });
});
