// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

import { DefaultMailApp } from '../DefaultMailApp';

// The rule this file protects: on macOS and Windows the OS forbids an app from
// claiming the mailto default, so this row must never announce a success the
// re-query did not confirm. It reports what the backend observed, nothing more.
//
// Every assertion reads a data attribute, never the copy — the copy is
// translated into nine catalogs and a test that reads it is a test that lies
// the first time someone localises it.

// `mockReset()` here makes a rejected implementation surface as an unhandled
// error even though the component catches it — a vitest artifact, not a defect
// (proved with the same component and no reset). Clear the calls, set an
// explicit default, and every test still starts from a known state.
beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve({ isDefault: false, canSet: false, hint: '' }));
});
afterEach(cleanup);

const status = over => ({ isDefault: false, canSet: false, hint: '', ...over });

describe('Default email app row', () => {
  it('reports that MailVault already handles mail links', async () => {
    invoke.mockResolvedValue(status({ isDefault: true }));

    render(<DefaultMailApp />);

    const state = await screen.findByTestId('default-mail-state');
    expect(state.dataset.default).toBe('true');
    expect(screen.queryByTestId('default-mail-action')).toBeNull();
  });

  it('offers to set the default where the OS allows it', async () => {
    invoke.mockResolvedValue(status({ canSet: true }));

    render(<DefaultMailApp />);

    const button = await screen.findByTestId('default-mail-action');
    expect(button.dataset.action).toBe('set');
  });

  it('offers instructions instead where the OS forbids it', async () => {
    invoke.mockResolvedValue(status({ canSet: false, hint: 'macos_mail_app' }));

    render(<DefaultMailApp />);

    const button = await screen.findByTestId('default-mail-action');
    expect(button.dataset.action).toBe('howto');
  });

  it('does not claim success when the attempt left us undefaulted', async () => {
    // The macOS path: LSSetDefaultHandlerForURLScheme is blocked by the App
    // Sandbox, so the re-query still says no. A row that flipped optimistically
    // on the click would lie here.
    invoke.mockResolvedValueOnce(status({ canSet: true }));
    render(<DefaultMailApp />);
    const button = await screen.findByTestId('default-mail-action');

    invoke.mockResolvedValueOnce(status({ canSet: false, hint: 'macos_mail_app' }));
    fireEvent.click(button);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mailto_make_default'));
    await waitFor(() => {
      expect(screen.getByTestId('default-mail-action').dataset.action).toBe('howto');
    });
    expect(screen.getByTestId('default-mail-state').dataset.default).toBe('false');
  });

  it('survives a backend that cannot answer', async () => {
    invoke.mockImplementation(() => Promise.reject(new Error('no such command')));

    render(<DefaultMailApp />);

    // Renders rather than throwing: this row is never load-bearing.
    const state = await screen.findByTestId('default-mail-state');
    expect(state.dataset.default).toBe('false');
  });
});
