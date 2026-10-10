// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore, PALETTES } from '../themeStore';

const attr = () => document.documentElement.getAttribute('data-palette');

beforeEach(() => {
  useThemeStore.setState({ palette: 'graphite' });
  document.documentElement.setAttribute('data-palette', 'graphite');
});

describe('themeStore palettes', () => {
  it('lists indigo, graphite and teal, in the order the pickers show them', () => {
    expect(PALETTES).toEqual(['indigo', 'graphite', 'teal']);
  });

  it('accepts every listed palette and mirrors it on the root element', () => {
    for (const palette of PALETTES) {
      useThemeStore.getState().setPalette(palette);
      expect(useThemeStore.getState().palette).toBe(palette);
      expect(attr()).toBe(palette);
    }
  });

  it('rejects an unknown palette without touching state or the root element', () => {
    useThemeStore.getState().setPalette('teal');
    useThemeStore.getState().setPalette('magenta');
    expect(useThemeStore.getState().palette).toBe('teal');
    expect(attr()).toBe('teal');
  });

  it('initTheme restores a saved teal choice onto the root element', () => {
    useThemeStore.setState({ palette: 'teal' });
    useThemeStore.getState().initTheme();
    expect(attr()).toBe('teal');
  });
});
