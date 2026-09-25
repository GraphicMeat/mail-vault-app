// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

import { DaemonAlwaysOn } from '../DaemonAlwaysOn';
import { useSettingsStore } from '../../../stores/settingsStore';

// The rule this file protects: the switch, and the persisted `daemonAlwaysOn`
// flag behind it, reflect what the OS reported — never what was clicked.
//
// That flag is not decoration. Rust reads it straight off
// `frontend-settings.json` inside `RunEvent::Exit`, when the webview is
// already gone, to decide whether to leave the daemon running. A flag left
// saying "on" after macOS refused the login item means a daemon that survives
// every quit and never starts at login: the worst of both.
//
// Assertions read `aria-checked` and data attributes, never the copy — the
// copy lives in nine catalogs, and a test that reads it lies the first time
// someone translates it.

const state = over => ({ supported: true, enabled: false, needsApproval: false, ...over });

beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve(state()));
  useSettingsStore.setState({ daemonAlwaysOn: false });
});
afterEach(cleanup);

const toggle = () => screen.findByTestId('daemon-always-on');

describe('Keep the daemon running in the background', () => {
  it('draws the switch from what the backend reports, not from the store', async () => {
    useSettingsStore.setState({ daemonAlwaysOn: false });
    invoke.mockResolvedValue(state({ enabled: true }));

    render(<DaemonAlwaysOn />);

    await waitFor(() => expect(useSettingsStore.getState().daemonAlwaysOn).toBe(true));
    expect((await toggle()).getAttribute('aria-checked')).toBe('true');
  });

  it('registers the login item and persists the flag Rust reads at exit', async () => {
    render(<DaemonAlwaysOn />);
    // The first read has to land before the click, or the switch is driven
    // from a state the component has not seen yet.
    await waitFor(() => expect(useSettingsStore.getState().daemonAlwaysOn).toBe(false));
    invoke.mockResolvedValue(state({ enabled: true }));

    fireEvent.click(await toggle());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_autostart', { enabled: true }));
    await waitFor(() => expect(useSettingsStore.getState().daemonAlwaysOn).toBe(true));
  });

  it('turns it off again', async () => {
    invoke.mockResolvedValue(state({ enabled: true }));
    render(<DaemonAlwaysOn />);
    await waitFor(() => expect(useSettingsStore.getState().daemonAlwaysOn).toBe(true));

    invoke.mockResolvedValue(state({ enabled: false }));
    fireEvent.click(await toggle());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_autostart', { enabled: false }));
    await waitFor(() => expect(useSettingsStore.getState().daemonAlwaysOn).toBe(false));
  });

  // A registration macOS refused must not leave the persisted flag claiming
  // success, or the app stops killing a daemon that never starts at login.
  it('keeps the flag off when the OS refuses', async () => {
    render(<DaemonAlwaysOn />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('autostart_state', {}));

    invoke.mockImplementation(cmd => (cmd === 'set_autostart'
      ? Promise.reject(new Error('macOS refused to register the login item'))
      : Promise.resolve(state({ enabled: false }))));

    fireEvent.click(await toggle());

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(useSettingsStore.getState().daemonAlwaysOn).toBe(false);
    expect((await toggle()).getAttribute('aria-checked')).toBe('false');
  });

  // "Registered, waiting for approval in System Settings" reads as on, and is,
  // but nothing starts until the user allows it. Saying so is the whole point.
  it('says so while macOS is still waiting for approval', async () => {
    invoke.mockResolvedValue(state({ enabled: true, needsApproval: true }));

    render(<DaemonAlwaysOn />);

    await waitFor(() => expect(useSettingsStore.getState().daemonAlwaysOn).toBe(true));
    expect(screen.getByTestId('daemon-always-on').getAttribute('aria-checked')).toBe('true');
  });

  it('disables the switch where the platform cannot do it', async () => {
    invoke.mockResolvedValue({ supported: false, enabled: false, reason: 'snap', needsApproval: false });

    render(<DaemonAlwaysOn />);

    expect((await toggle()).getAttribute('aria-disabled')).toBe('true');
  });

  // A copy running from a drive must not register itself at login on the host.
  it('says why when this is a portable copy', async () => {
    invoke.mockResolvedValue({ supported: false, enabled: false, reason: 'portable', needsApproval: false });

    render(<DaemonAlwaysOn />);

    expect((await toggle()).getAttribute('aria-disabled')).toBe('true');
    expect((await screen.findByTestId('daemon-always-on-reason')).textContent.length > 0).toBe(true);
  });

  // Browser preview and older builds have no such command; the row goes quiet
  // rather than offering a switch that reaches nothing.
  it('renders nothing when the backend does not answer', async () => {
    invoke.mockRejectedValue(new Error('unknown command'));

    const { container } = render(<DaemonAlwaysOn />);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
