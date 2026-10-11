// @vitest-environment jsdom
//
// Sparkle shows its own "An error occurred while running the updater" alert
// when its installer dies before touching the app. The download is intact and
// a fresh app process installs it (seen on 2.15.0 -> 2.19.1: the first try
// after installing from a download failed, quit + reopen installed it), so
// after that alert MailVault offers to restart and finish.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const harness = { listeners: new Map(), relaunch: vi.fn() };
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    harness.listeners.set(name, cb);
    return () => harness.listeners.delete(name);
  },
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: (...a) => harness.relaunch(...a) }));

const { UpdateInstallFailedPrompt } = await import('../UpdateInstallFailedPrompt');
const { useSettingsStore } = await import('../../stores/settingsStore');

const abort = async (payload) => {
  await act(async () => { await harness.listeners.get('sparkle://did-abort-with-error')?.({ payload }); });
};
const installerDied = { domain: 'SUSparkleErrorDomain', code: 4005, message: 'An error occurred while running the updater. Please try again later.' };

let snapshot;
beforeEach(() => {
  harness.listeners.clear();
  harness.relaunch.mockReset();
  harness.relaunch.mockResolvedValue(undefined);
  snapshot = useSettingsStore.getState();
  useSettingsStore.setState({ updateResumeAfterRestart: false });
});
afterEach(() => { cleanup(); useSettingsStore.setState(snapshot, true); });

describe('UpdateInstallFailedPrompt', () => {
  it('stays hidden until Sparkle reports the installer dying', async () => {
    render(<UpdateInstallFailedPrompt />);
    await act(async () => {});
    expect(harness.listeners.has('sparkle://did-abort-with-error')).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await abort({ domain: 'SUSparkleErrorDomain', code: 2001, message: 'download' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await abort({ domain: 'SUSparkleErrorDomain', code: 4007, message: 'cancelled' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers a restart once the installer died, and restarts with the resume flag set', async () => {
    render(<UpdateInstallFailedPrompt />);
    await act(async () => {});
    await abort(installerDied);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Update could not be installed');
    expect(dialog.textContent).toContain('Restart MailVault');
    fireEvent.click(screen.getByRole('button', { name: 'Restart and install' }));
    expect(useSettingsStore.getState().updateResumeAfterRestart).toBe(true);
    // The flag is flushed to disk first, so the restart lands a tick later.
    await waitFor(() => expect(harness.relaunch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Later closes it and leaves the flag alone', async () => {
    render(<UpdateInstallFailedPrompt />);
    await act(async () => {});
    await abort(installerDied);
    // The dialog's X carries the same label; the footer button is the last one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Later' }).at(-1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useSettingsStore.getState().updateResumeAfterRestart).toBe(false);
    expect(harness.relaunch).not.toHaveBeenCalled();
  });
});
