// @vitest-environment jsdom
//
// On Windows and Linux the main window's close button quits unless the user
// keeps the app in the tray. Rust reads `closeToTray` from the persisted
// settings file at close time, so the store is the record. macOS always keeps
// running on close and has no such choice.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn().mockResolvedValue('2.16.0') }));

import { BehaviorSettings } from '../BehaviorSettings';
import { useSettingsStore } from '../../../stores/settingsStore';

const onPlatform = (platform, userAgent) => {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
};

beforeEach(() => useSettingsStore.setState({ closeToTray: false }));
afterEach(cleanup);

describe('Keep running in the tray when closed', () => {
  it.each([
    ['Windows', 'Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'],
    ['Linux', 'Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)'],
  ])('is offered on %s, off by default, and writes the store', async (_os, platform, userAgent) => {
    onPlatform(platform, userAgent);
    render(<BehaviorSettings />);
    const toggle = await screen.findByTestId('toggle-close-to-tray');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().closeToTray).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('is not offered on macOS, where closing never quits', async () => {
    onPlatform('MacIntel', 'Mozilla/5.0 (Macintosh)');
    render(<BehaviorSettings />);
    await screen.findByTestId('after-delete-select');
    expect(screen.queryByTestId('toggle-close-to-tray')).toBeNull();
  });
});
