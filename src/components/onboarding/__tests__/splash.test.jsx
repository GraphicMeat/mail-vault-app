// src/components/onboarding/__tests__/splash.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const setLocale = vi.fn(() => Promise.resolve());
vi.mock('../../../i18n/index.js', async () => {
  const actual = await vi.importActual('../../../i18n/index.js');
  return { ...actual, setLocale: (c) => setLocale(c) };
});

import { Splash } from '../Splash';

afterEach(() => { cleanup(); setLocale.mockClear(); });

describe('onboarding splash', () => {
  it('shows the Graphic Meat logo', () => {
    render(<Splash onContinue={() => {}} />);
    const img = screen.getByTestId('onboarding-logo');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('alt')).toMatch(/Graphic Meat/i);
  });

  it('offers all nine languages', () => {
    render(<Splash onContinue={() => {}} />);
    expect(screen.getAllByTestId(/^onboarding-language-/)).toHaveLength(9);
  });

  // setLocale is the one call that loads the catalog, writes `language` AND
  // bumps localeEpoch. Anything hand-rolled here repaints nothing.
  it('switches language through setLocale', () => {
    render(<Splash onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-language-de'));
    expect(setLocale).toHaveBeenCalledWith('de');
  });

  it('advances only when Continue is pressed', () => {
    const onContinue = vi.fn();
    render(<Splash onContinue={onContinue} />);
    fireEvent.click(screen.getByTestId('onboarding-language-ja'));
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalled();
  });
});
