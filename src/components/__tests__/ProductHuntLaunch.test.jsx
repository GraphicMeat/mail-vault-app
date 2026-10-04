// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openInBrowser = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../../services/billingApi', () => ({ openInBrowser }));

import { ProductHuntLaunch } from '../ProductHuntLaunch';
import { useSettingsStore } from '../../stores/settingsStore';
import { LAUNCH_END, LAUNCH_START, NEW_USER_DELAY_MS, PRODUCT_HUNT_URL } from '../../utils/productHuntLaunch';

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ onboardingComplete: true, onboardingCompletedAt: null });
  document.body.innerHTML = '<div id="root"></div>';
  // Node's own experimental localStorage shadows jsdom's here and throws.
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, String(v)); },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openInBrowser.mockClear();
});

describe('ProductHuntLaunch', () => {
  it('shows nothing outside the launch window', () => {
    vi.setSystemTime(LAUNCH_START - 60_000);
    render(<ProductHuntLaunch />);
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();
  });

  it('appears by itself when the window opens and leaves when it closes', () => {
    vi.setSystemTime(LAUNCH_START - 1000);
    render(<ProductHuntLaunch />);
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();

    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.getByTestId('product-hunt-launch')).toBeTruthy();

    act(() => { vi.setSystemTime(LAUNCH_END); vi.advanceTimersByTime(24 * 60 * 60 * 1000); });
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();
  });

  it('cannot be closed, only opened, and locks the app behind it', () => {
    vi.setSystemTime(LAUNCH_START + 1000);
    const { unmount } = render(<ProductHuntLaunch />);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(true);

    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(seen).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    document.removeEventListener('keydown', seen);
    unmount();
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
  });

  it('hides for good once the button has opened Product Hunt', async () => {
    vi.setSystemTime(LAUNCH_START + 1000);
    const { unmount } = render(<ProductHuntLaunch />);

    await act(async () => { fireEvent.click(screen.getByTestId('product-hunt-open')); });
    expect(openInBrowser).toHaveBeenCalledWith(PRODUCT_HUNT_URL);
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);

    unmount();
    render(<ProductHuntLaunch />);
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();
  });

  it('stays up when the browser could not be opened', async () => {
    vi.setSystemTime(LAUNCH_START + 1000);
    openInBrowser.mockRejectedValueOnce(new Error('blocked'));
    render(<ProductHuntLaunch />);

    await act(async () => { fireEvent.click(screen.getByTestId('product-hunt-open')); });
    expect(screen.getByTestId('product-hunt-launch')).toBeTruthy();
  });

  it('waits until onboarding is finished, then 10 minutes more for a new user', () => {
    vi.setSystemTime(LAUNCH_START + 1000);
    useSettingsStore.setState({ onboardingComplete: false, onboardingCompletedAt: null });
    render(<ProductHuntLaunch />);
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();

    act(() => { useSettingsStore.getState().setOnboardingComplete(true); });
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();

    act(() => { vi.advanceTimersByTime(NEW_USER_DELAY_MS - 1000); });
    expect(screen.queryByTestId('product-hunt-launch')).toBeNull();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.getByTestId('product-hunt-launch')).toBeTruthy();
  });

  it('never shows in a WebDriver build, even without VITE_E2E', () => {
    // CI's ui-headless suite builds the frontend without VITE_E2E; on launch
    // day the page made #root inert and every spec that opened Settings failed.
    vi.setSystemTime(LAUNCH_START + 1000);
    window.__WEBDRIVER__ = {};
    try {
      render(<ProductHuntLaunch />);
      expect(screen.queryByTestId('product-hunt-launch')).toBeNull();
      expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    } finally {
      delete window.__WEBDRIVER__;
    }
  });

  it('says when the page ends in local time and how long is left', () => {
    vi.setSystemTime(LAUNCH_END - (5 * 60 + 30) * 60 * 1000 + 20_000);
    render(<ProductHuntLaunch />);
    const note = screen.getByTestId('product-hunt-launch').querySelector('.ph-note');
    expect(note.textContent).toMatch(/will not be shown after/);
    expect(note.textContent).toContain(new Intl.DateTimeFormat('en', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(LAUNCH_END));
    expect(note.textContent).toMatch(/5h 30m left/);
  });
});
