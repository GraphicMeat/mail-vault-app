// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppearanceSettings } from '../AppearanceSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  useSettingsStore.setState({ appFont: 'instrument-sans', textScale: 1 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('text settings', () => {
  it('has its own Appearance tab', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('tab', { name: t('settings.appearance.section.text') }));
    expect(screen.getByRole('group', { name: t('settings.text.codingFonts') })).toBeTruthy();
  });

  it('picks a font, each drawn in its own face, with coding fonts in their own group', () => {
    render(<AppearanceSettings initialSection="text" />);
    const coding = screen.getByRole('group', { name: t('settings.text.codingFonts') });
    expect(within(coding).getAllByRole('button').map(button => button.textContent)).toEqual(['JetBrains Mono', 'Fira Code', 'IBM Plex Mono']);
    const ui = screen.getByRole('group', { name: t('settings.text.interfaceFonts') });
    expect(within(ui).queryByRole('button', { name: /Fira Code/ })).toBeNull();
    const inter = within(ui).getByRole('button', { name: /Inter/ });
    expect(inter.style.fontFamily).toContain('Inter');

    fireEvent.click(within(coding).getByRole('button', { name: /Fira Code/ }));
    expect(useSettingsStore.getState().appFont).toBe('fira-code');
    expect(within(coding).getByRole('button', { name: /Fira Code/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(ui).getByRole('button', { name: t('settings.text.systemFont') }));
    expect(useSettingsStore.getState().appFont).toBe('system');
  });

  it('sets the text size', () => {
    render(<AppearanceSettings initialSection="text" />);
    fireEvent.click(screen.getByRole('radio', { name: '125%' }));
    expect(useSettingsStore.getState().textScale).toBe(1.25);
    expect(screen.getByRole('radio', { name: '125%' }).getAttribute('aria-checked')).toBe('true');
  });
});
