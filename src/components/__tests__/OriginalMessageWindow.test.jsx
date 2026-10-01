// @vitest-environment jsdom
//
// The pop-out of a reply's original gets the HTML over IPC, so it shows that
// one body, but in the theme the compose pane was showing, with its own
// light/dark toggle.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const { handlers, emit } = vi.hoisted(() => ({ handlers: [], emit: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  // The privacy-mode sync listener is not the window's payload handler.
  listen: vi.fn(async (name, handler) => { if (name !== 'privacy-mode-changed') handlers.push(handler); return () => {}; }),
  emit,
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'original-1' }) }));

vi.mock('../../stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

window.history.replaceState({}, '', '/?original=tok');
const { OriginalMessageWindow } = await import('../OriginalMessageWindow');
const { useSettingsStore } = await import('../../stores/settingsStore');

const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active' };
const BEACON = 'https://example.list-manage.com/track/open.php?u=8f2&id=a91';

const frameTheme = () => new DOMParser()
  .parseFromString(document.querySelector('iframe').getAttribute('srcdoc'), 'text/html')
  .documentElement.getAttribute('data-mv-theme');

async function deliver(payload) {
  render(<OriginalMessageWindow />);
  await waitFor(() => expect(emit).toHaveBeenCalledWith('original-message-ready', { token: 'tok', label: 'original-1' }));
  act(() => handlers.at(-1)({ payload: { token: 'tok', html: '<p>Original body</p>', ...payload } }));
  await screen.findByTitle('Original Message');
}

beforeEach(() => useSettingsStore.setState({ emailViewerTheme: 'light' }));
afterEach(() => { cleanup(); handlers.length = 0; vi.clearAllMocks(); });

describe('the original message window', () => {
  it('opens in the theme the compose pane sent', async () => {
    await deliver({ dark: true });
    expect(frameTheme()).toBe('dark');
    expect(document.querySelector('iframe').getAttribute('srcdoc')).toContain('Original body');
    expect(screen.getByTestId('original-window-theme').getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the email theme setting when the payload names none', async () => {
    useSettingsStore.setState({ emailViewerTheme: 'dark' });
    await deliver({});
    expect(frameTheme()).toBe('dark');
  });

  it('flips light and dark with its toggle, running scripts only when dark', async () => {
    await deliver({ dark: false });
    const toggle = screen.getByTestId('original-window-theme');
    expect(frameTheme()).toBe('light');
    expect(document.querySelector('iframe').getAttribute('sandbox')).toBe('allow-same-origin');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('title')).toBe('Dark');

    fireEvent.click(toggle);
    expect(frameTheme()).toBe('dark');
    expect(document.querySelector('iframe').getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
    expect(screen.getByTestId('original-window-theme').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores a payload for another window', async () => {
    render(<OriginalMessageWindow />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    act(() => handlers.at(-1)({ payload: { token: 'other', html: '<p>Not mine</p>', dark: true } }));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('strips a tracking beacon in the detached original the same way the reading pane would', async () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, trackerBlockingEnabled: true });
    await deliver({ html: `<p>Hi</p><img src="${BEACON}" width="1" height="1">` });
    expect(document.querySelector('iframe').getAttribute('srcdoc')).not.toContain('list-manage.com');
  });

  it('keeps the beacon in the detached original when blocking is off, same as the reading pane', async () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, trackerBlockingEnabled: false });
    await deliver({ html: `<p>Hi</p><img src="${BEACON}" width="1" height="1">` });
    expect(document.querySelector('iframe').getAttribute('srcdoc')).toContain(BEACON);
  });
});
