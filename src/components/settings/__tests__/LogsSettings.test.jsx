// @vitest-environment jsdom
//
// Settings > Diagnostics > Logs: the Standard/Verbose control (Task F2). The
// RPC name and payload come from F1's committed contract (logs.set_verbosity,
// {"verbosity": "standard"|"verbose"}).

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const daemonCall = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../../services/daemonClient', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));

const { LogsSettings } = await import('../LogsSettings');
const { useSettingsStore } = await import('../../../stores/settingsStore');

afterEach(() => { cleanup(); daemonCall.mockClear(); });

describe('LogsSettings verbosity toggle', () => {
  it('defaults to standard selected', () => {
    useSettingsStore.setState({ logVerbosity: 'standard' });
    render(<LogsSettings />);
    expect(screen.getByTestId('log-verbosity-standard').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('log-verbosity-verbose').getAttribute('aria-checked')).toBe('false');
  });

  it('switching to verbose calls logs.set_verbosity and persists it in the store', async () => {
    useSettingsStore.setState({ logVerbosity: 'standard' });
    render(<LogsSettings />);
    fireEvent.click(screen.getByTestId('log-verbosity-verbose'));

    expect(useSettingsStore.getState().logVerbosity).toBe('verbose');
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('logs.set_verbosity', { verbosity: 'verbose' }));
  });

  it('switching back to standard calls the RPC with standard', async () => {
    useSettingsStore.setState({ logVerbosity: 'verbose' });
    render(<LogsSettings />);
    fireEvent.click(screen.getByTestId('log-verbosity-standard'));

    expect(useSettingsStore.getState().logVerbosity).toBe('standard');
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('logs.set_verbosity', { verbosity: 'standard' }));
  });
});
