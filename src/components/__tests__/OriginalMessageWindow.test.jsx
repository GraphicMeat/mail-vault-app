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
  listen: vi.fn(async (_name, handler) => { handlers.push(handler); return () => {}; }),
  emit,
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'original-1' }) }));

window.history.replaceState({}, '', '/?original=tok');
const { OriginalMessageWindow } = await import('../OriginalMessageWindow');
const { useSettingsStore } = await import('../../stores/settingsStore');

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
});
