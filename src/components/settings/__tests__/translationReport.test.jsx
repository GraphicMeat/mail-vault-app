// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const openInBrowser = vi.fn().mockResolvedValue(true);
vi.mock('../../../services/billingApi', () => ({ openInBrowser: (...a) => openInBrowser(...a) }));

import { TranslationIssueReport } from '../TranslationIssueReport';
import { setLocale } from '../../../i18n/index.js';

beforeEach(() => { openInBrowser.mockClear(); });
afterEach(async () => { cleanup(); await setLocale('en'); });

const fill = () => {
  fireEvent.change(screen.getByTestId('tr-wrong'), { target: { value: 'Alle Posteingang' } });
  fireEvent.change(screen.getByTestId('tr-fix'), { target: { value: 'Alle Posteingänge' } });
};

describe('TranslationIssueReport', () => {
  it('keeps submit disabled until both the wrong text and the correction are given', () => {
    render(<TranslationIssueReport />);
    expect(screen.getByTestId('tr-submit').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('tr-wrong'), { target: { value: 'Alle Posteingang' } });
    expect(screen.getByTestId('tr-submit').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('tr-fix'), { target: { value: 'Alle Posteingänge' } });
    expect(screen.getByTestId('tr-submit').disabled).toBe(false);
  });

  it('defaults the language to the active locale', async () => {
    await setLocale('de');
    render(<TranslationIssueReport />);
    expect(screen.getByTestId('tr-lang').value).toBe('de');
  });

  it('opens a GitHub discussion carrying the locale, both strings and the app version', async () => {
    await setLocale('de');
    render(<TranslationIssueReport />);
    fill();
    fireEvent.click(screen.getByTestId('tr-submit'));

    await waitFor(() => expect(openInBrowser).toHaveBeenCalledTimes(1));
    const url = new URL(openInBrowser.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/new');
    expect(url.searchParams.get('category')).toBe('bug-reports');
    expect(url.searchParams.get('title')).toContain('[i18n de]');
    const body = url.searchParams.get('body');
    expect(body).toContain('Alle Posteingang');
    expect(body).toContain('Alle Posteingänge');
    expect(body).toContain('de');
    expect(body).toMatch(/\d+\.\d+\.\d+/);
  });

  it('clears the form after a successful submit', async () => {
    render(<TranslationIssueReport />);
    fill();
    fireEvent.click(screen.getByTestId('tr-submit'));
    await waitFor(() => expect(screen.getByTestId('tr-wrong').value).toBe(''));
    expect(screen.getByTestId('tr-fix').value).toBe('');
  });
});
