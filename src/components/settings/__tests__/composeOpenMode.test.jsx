// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { setLocale } from '../../../i18n/index.js';
import { ComposeOpenMode } from '../ComposeOpenMode';

beforeEach(async () => {
  useSettingsStore.setState({ composeOpenMode: 'app' });
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
});
