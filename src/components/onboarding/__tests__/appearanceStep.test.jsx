// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useThemeStore } from '../../../stores/themeStore';
import { t } from '../../../i18n';
import { AppearanceStep } from '../AppearanceStep';

beforeEach(() => {
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
  useSettingsStore.setState({ layoutMode: 'three-column', sidebarStyle: 'list', sidebarLayout: 'stacked', viewStyle: 'list', emailListStyle: 'compact', threadMode: 'grouped', afterDeleteSelect: 'none', emailRowHighlight: 'hover', emailViewerTheme: 'system', actionButtonDisplay: 'icon-label' });
});
afterEach(cleanup);
const tab = name => screen.getByRole('tab', { name: t(`settings.appearance.section.${name}`) });

describe('appearance step', () => {
  it('shows two color choices groups, with secondary preferences kept out of initial setup', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getAllByTestId(/^appearance-control-/)).toHaveLength(2);
    expect(screen.getByTestId('appearance-control-palette')).toBeTruthy();
    expect(screen.queryByTestId('appearance-control-after-delete')).toBeNull();
    expect(screen.queryByTestId('appearance-control-sidebar')).toBeNull();
  });

  it('lets the keyboard move between focused sections without losing the preview', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.keyDown(tab('colors'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('layout'));
    expect(screen.getByTestId('appearance-control-layout')).toBeTruthy();
    expect(screen.queryByTestId('appearance-control-theme')).toBeNull();
    fireEvent.keyDown(tab('layout'), { key: 'End' });
    expect(screen.getByTestId('appearance-control-threads')).toBeTruthy();
    expect(screen.getAllByTestId('appearance-preview')).toHaveLength(1);
  });

  it('updates the sample and persisted choices across tabs', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('appearance-theme-light'));
    fireEvent.click(screen.getByTestId('appearance-palette-graphite'));
    fireEvent.click(tab('layout'));
    fireEvent.click(screen.getByTestId('appearance-layout-two-column'));
    fireEvent.click(tab('reading'));
    fireEvent.click(screen.getByTestId('appearance-threads-flat'));
    expect(useSettingsStore.getState()).toMatchObject({ layoutMode: 'two-column', threadMode: 'flat' });
    expect(useThemeStore.getState()).toMatchObject({ theme: 'light', palette: 'graphite' });
    expect(screen.getByTestId('preview-panes').dataset.layout).toBe('two-column');
    expect(screen.getByTestId('appearance-preview').dataset).toMatchObject({ theme: 'light', palette: 'graphite' });
    fireEvent.click(tab('colors'));
    expect(screen.getByTestId('appearance-palette-graphite').getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves email preferences and explains unavailable controls in Chat', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('layout'));
    fireEvent.click(screen.getByTestId('appearance-layout-two-column'));
    fireEvent.click(screen.getByTestId('appearance-view-chat'));
    expect(screen.getByTestId('preview-chat')).toBeTruthy();
    for (const button of within(screen.getByTestId('appearance-control-layout')).getAllByRole('button')) expect(button.disabled).toBe(true);
    fireEvent.click(tab('reading'));
    for (const id of ['density', 'threads']) for (const button of within(screen.getByTestId(`appearance-control-${id}`)).getAllByRole('button')) expect(button.disabled).toBe(true);
    expect(screen.getByText(t('workspace.emailViewOnly'))).toBeTruthy();
    fireEvent.click(tab('layout'));
    fireEvent.click(screen.getByTestId('appearance-view-list'));
    expect(screen.getByTestId('preview-panes').dataset.layout).toBe('two-column');
  });

  it('applies current recommended defaults, including Follow the pointer', () => {
    useThemeStore.setState({ theme: 'light', palette: 'graphite' });
    useSettingsStore.setState({ layoutMode: 'two-column', sidebarStyle: 'tagcloud', sidebarLayout: 'switcher', viewStyle: 'chat', emailListStyle: 'default', threadMode: 'flat', afterDeleteSelect: 'next', emailRowHighlight: 'selection' });
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('appearance-recommended'));
    expect(useThemeStore.getState()).toMatchObject({ theme: 'dark', palette: 'indigo' });
    expect(useSettingsStore.getState()).toMatchObject({ layoutMode: 'three-column', sidebarStyle: 'list', sidebarLayout: 'stacked', viewStyle: 'list', emailListStyle: 'compact', threadMode: 'grouped', afterDeleteSelect: 'none', emailRowHighlight: 'hover' });
  });

  it('can continue from any tab without resetting existing preferences', () => {
    const onContinue = vi.fn();
    useSettingsStore.setState({ sidebarStyle: 'tagcloud', afterDeleteSelect: 'next', emailRowHighlight: 'selection' });
    render(<AppearanceStep onContinue={onContinue} />);
    fireEvent.click(tab('reading'));
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState()).toMatchObject({ sidebarStyle: 'tagcloud', afterDeleteSelect: 'next', emailRowHighlight: 'selection' });
  });
});
