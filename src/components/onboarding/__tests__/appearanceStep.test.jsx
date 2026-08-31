// src/components/onboarding/__tests__/appearanceStep.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const setLayoutMode = vi.fn();
const setSidebarStyle = vi.fn();
const setViewStyle = vi.fn();
const setEmailListStyle = vi.fn();
const toggleTheme = vi.fn();
const setTheme = vi.fn();

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (sel) => sel({
    layoutMode: 'three-column', sidebarStyle: 'list', viewStyle: 'list', emailListStyle: 'default',
    setLayoutMode, setSidebarStyle, setViewStyle, setEmailListStyle,
    localeEpoch: 0,
  }),
}));
vi.mock('../../../stores/themeStore', () => ({
  useThemeStore: (sel) => sel({ theme: 'dark', toggleTheme, setTheme }),
}));

import { AppearanceStep } from '../AppearanceStep';

afterEach(() => { cleanup(); [setLayoutMode, setSidebarStyle, setViewStyle, setEmailListStyle, toggleTheme, setTheme].forEach(m => m.mockClear()); });

describe('appearance step', () => {
  it('offers exactly the five first-run controls', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    expect(screen.getAllByTestId(/^appearance-control-/).map(n => n.dataset.testid || n.getAttribute('data-testid')))
      .toEqual([
        'appearance-control-theme',
        'appearance-control-layout',
        'appearance-control-sidebar',
        'appearance-control-view',
        'appearance-control-density',
      ]);
  });

  it('writes straight to the live stores', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('appearance-layout-two-column'));
    expect(setLayoutMode).toHaveBeenCalledWith('two-column');
    fireEvent.click(screen.getByTestId('appearance-theme-toggle'));
    expect(toggleTheme).toHaveBeenCalled();
  });

  // One click has to move every one of the five controls: a partial preset
  // leaves the screen half-recommended and nobody can tell which half.
  it('applies the recommended settings in one click', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('appearance-recommended'));
    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(setLayoutMode).toHaveBeenCalledWith('three-column');
    expect(setSidebarStyle).toHaveBeenCalledWith('tagcloud');
    expect(setViewStyle).toHaveBeenCalledWith('list');
    expect(setEmailListStyle).toHaveBeenCalledWith('compact');
  });

  it('renders the preview beside the controls', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    expect(screen.getByTestId('appearance-preview')).toBeTruthy();
  });

  it('continues to the next step', () => {
    const onContinue = vi.fn();
    render(<AppearanceStep onContinue={onContinue} />);
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalled();
  });
});
