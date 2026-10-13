// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SettingsRow from '../SettingsRow';
import { useSettingsStore } from '../../../stores/settingsStore';
import en from '../../../i18n/locales/en.json';

beforeEach(() => { useSettingsStore.setState({ emailRenderer: 'web' }); });
afterEach(cleanup);

describe('SettingsRow', () => {
  it('the switch has an accessible name, the row title', () => {
    render(<SettingsRow />);
    expect(screen.getByRole('switch', { name: en['blitz.settings.title'] })).toBeTruthy();
  });
  it('flips the renderer setting', () => {
    render(<SettingsRow />);
    const sw = screen.getByRole('switch', { name: en['blitz.settings.title'] });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(useSettingsStore.getState().emailRenderer).toBe('blitz');
    fireEvent.click(screen.getByRole('switch', { name: en['blitz.settings.title'] }));
    expect(useSettingsStore.getState().emailRenderer).toBe('web');
  });
});
