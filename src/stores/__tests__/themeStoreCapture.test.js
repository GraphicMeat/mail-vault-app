// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore, selectTheme } from '../themeStore';

const attr = () => document.documentElement.getAttribute('data-theme');

beforeEach(() => {
  useThemeStore.setState({ theme: 'dark', captureTheme: null });
  document.documentElement.setAttribute('data-theme', 'dark');
});

describe('themeStore capture override', () => {
  it('selectTheme reads the override first, then the real theme', () => {
    expect(selectTheme({ theme: 'dark', captureTheme: null })).toBe('dark');
    expect(selectTheme({ theme: 'dark', captureTheme: 'light' })).toBe('light');
    expect(selectTheme({ theme: 'dark' })).toBe('dark');
  });

  it('setCaptureTheme flips data-theme and the selector, and clearing restores the real theme', () => {
    useThemeStore.getState().setCaptureTheme('light');
    expect(attr()).toBe('light');
    expect(selectTheme(useThemeStore.getState())).toBe('light');
    expect(useThemeStore.getState().theme).toBe('dark');
    useThemeStore.getState().setCaptureTheme(null);
    expect(attr()).toBe('dark');
    expect(selectTheme(useThemeStore.getState())).toBe('dark');
  });

  it('clearing restores the CURRENT theme, not the one at flip time', () => {
    useThemeStore.getState().setCaptureTheme('light');
    useThemeStore.setState({ theme: 'light' });
    useThemeStore.getState().setCaptureTheme('dark');
    useThemeStore.setState({ theme: 'dark' });
    useThemeStore.getState().setCaptureTheme(null);
    expect(attr()).toBe('dark');
  });

  it('ignores junk and never touches the real theme', () => {
    useThemeStore.getState().setCaptureTheme('sepia');
    expect(useThemeStore.getState().captureTheme).toBeNull();
    expect(attr()).toBe('dark');
  });

  it('initTheme honours an override in flight', () => {
    useThemeStore.setState({ captureTheme: 'light' });
    useThemeStore.getState().initTheme();
    expect(attr()).toBe('light');
  });

  it('never persists the override', () => {
    const { partialize } = useThemeStore.persist.getOptions();
    expect(partialize({ theme: 'light', palette: 'indigo', captureTheme: 'dark', toggleTheme() {} }))
      .toEqual({ theme: 'light', palette: 'indigo' });
  });
});
