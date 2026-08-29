// @vitest-environment jsdom

/**
 * lucide-react is deliberately NOT mocked — the Proxy mock used elsewhere in
 * this directory breaks as soon as a component really renders an icon.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { LanguageSettings } from '../LanguageSettings';
import { setLocale, getLocale, LOCALES } from '../../../i18n/index.js';

afterEach(async () => { cleanup(); await setLocale('en'); });

describe('LanguageSettings', () => {
  it('lists all nine locales', () => {
    render(<LanguageSettings />);
    expect(screen.getAllByTestId(/^language-row-/)).toHaveLength(LOCALES.length);
  });

  // Scoped to the radiogroup: the report form below also renders every native
  // name as a <select> option, so an unscoped getByText matches twice.
  it('labels each row with its native name', () => {
    render(<LanguageSettings />);
    const rows = within(screen.getByRole('radiogroup'));
    expect(rows.getByText('Deutsch')).toBeTruthy();
    expect(rows.getByText('日本語')).toBeTruthy();
    expect(rows.getByText('简体中文')).toBeTruthy();
  });

  it('marks the active locale as selected and no other', () => {
    render(<LanguageSettings />);
    const selected = screen.getAllByTestId(/^language-row-/)
      .filter(el => el.getAttribute('aria-checked') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-testid')).toBe('language-row-en');
  });

  it('switches the app language when a row is clicked', async () => {
    render(<LanguageSettings />);
    fireEvent.click(screen.getByTestId('language-row-de'));
    await waitFor(() => expect(getLocale()).toBe('de'));
    await waitFor(() =>
      expect(screen.getByTestId('language-row-de').getAttribute('aria-checked')).toBe('true')
    );
    expect(screen.getByTestId('language-row-en').getAttribute('aria-checked')).toBe('false');
  });
});
