// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { setLocale } from '../../../i18n/index.js';
import { ComposeOpenMode } from '../ComposeOpenMode';

beforeEach(async () => {
  useSettingsStore.setState({ composeOpenMode: 'app', composeContextSplit: null });
  await setLocale('en');
});
afterEach(cleanup);

describe('ComposeOpenMode', () => {
  it('switches between opening in the app and in a new window', () => {
    render(<ComposeOpenMode />);
    expect(screen.getByTestId('compose-open-app').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('compose-open-window'));
    expect(useSettingsStore.getState().composeOpenMode).toBe('window');
    expect(screen.getByTestId('compose-open-window').getAttribute('aria-checked')).toBe('true');
  });

  it('resets the remembered compose layout, and only once there is one', () => {
    render(<ComposeOpenMode />);
    const reset = screen.getByTestId('compose-layout-reset');
    expect(reset.disabled).toBe(true);
    act(() => useSettingsStore.getState().setComposeContextSplit(0.62));
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(useSettingsStore.getState().composeContextSplit).toBeNull();
    expect(reset.disabled).toBe(true);
  });

  it('keeps the reset out of the onboarding tour', () => {
    render(<ComposeOpenMode standalone />);
    expect(screen.queryByTestId('compose-layout-reset')).toBeNull();
  });
});
