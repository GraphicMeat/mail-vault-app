// @vitest-environment jsdom
//
// The responsive sidebar rule, moved out of App into useAutoCollapseSidebar
// and useWindowSize: a narrow window collapses the sidebar, a wide one gives
// it back, but only if the window (not the user) is what collapsed it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoCollapseSidebar } from '../app/useAutoCollapseSidebar';
import { useWindowSize } from '../app/useWindowSize';

const setup = (props) => {
  const setSidebarCollapsed = vi.fn();
  const hook = renderHook(p => useAutoCollapseSidebar({ setSidebarCollapsed, ...p }), { initialProps: props });
  return { setSidebarCollapsed, ...hook };
};

afterEach(() => { vi.restoreAllMocks(); });

describe('useAutoCollapseSidebar', () => {
  it('collapses an expanded sidebar when the window is narrower than 900px', () => {
    const { setSidebarCollapsed } = setup({ windowWidth: 800, sidebarCollapsed: false });
    expect(setSidebarCollapsed).toHaveBeenCalledTimes(1);
    expect(setSidebarCollapsed).toHaveBeenCalledWith(true);
  });

  it('gives the sidebar back when the window widens again', () => {
    const { setSidebarCollapsed, rerender } = setup({ windowWidth: 800, sidebarCollapsed: false });
    rerender({ windowWidth: 800, sidebarCollapsed: true });
    rerender({ windowWidth: 1000, sidebarCollapsed: true });
    expect(setSidebarCollapsed).toHaveBeenLastCalledWith(false);
    expect(setSidebarCollapsed).toHaveBeenCalledTimes(2);
  });

  it('does not re-expand a sidebar the user collapsed in a wide window', () => {
    const { setSidebarCollapsed, rerender } = setup({ windowWidth: 1200, sidebarCollapsed: false });
    rerender({ windowWidth: 1200, sidebarCollapsed: true });
    rerender({ windowWidth: 800, sidebarCollapsed: true });
    rerender({ windowWidth: 1000, sidebarCollapsed: true });
    expect(setSidebarCollapsed).not.toHaveBeenCalled();
  });
});

describe('useWindowSize', () => {
  it('follows the window as it is resized', () => {
    const { result } = renderHook(() => useWindowSize());
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toEqual({ windowWidth: 640, windowHeight: 480 });
  });
});
