// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let statusReply;
let progress = null;
const rebuild = vi.fn();
const destroy = vi.fn();
vi.mock('../../../services/searchIndex', () => ({
  status: () => Promise.resolve(statusReply),
  rebuild: (...args) => rebuild(...args),
  destroy: (...args) => destroy(...args),
  onProgress: async (cb) => { progress = cb; return () => { progress = null; }; },
}));

import { SearchIndexSettings } from '../SearchIndexSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
import { formatBytes } from '../../../utils/formatBytes';

const statusText = () => screen.getByTestId('search-index-status').textContent;

beforeEach(() => {
  statusReply = { available: true, state: 'indexing', indexed: 12, total: 40, sizeBytes: 2048, complete: false };
  progress = null;
  rebuild.mockReset().mockResolvedValue(undefined);
  destroy.mockReset().mockResolvedValue({ ok: true });
  useSettingsStore.setState({ searchIndexBodies: true, searchIndexAttachments: true, searchIndexImageText: true, searchIndexEnabled: true });
});
afterEach(cleanup);

describe('Search index settings', () => {
  it('shows how much is indexed, its size, and a progress bar while indexing', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => expect(statusText()).toBe(`12 / 40 indexed · ${formatBytes(2048)}`));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
  });

  it('turns message bodies off and on', async () => {
    render(<SearchIndexSettings />);
    const toggle = screen.getByTestId('search-index-bodies');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexBodies).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexBodies).toBe(true);
    await waitFor(() => screen.getByTestId('search-index-status'));
  });

  it('turns attachment indexing off and on', async () => {
    render(<SearchIndexSettings />);
    const toggle = screen.getByTestId('search-index-attachments');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexAttachments).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexAttachments).toBe(true);
  });

  it('turns image text recognition off and on', async () => {
    render(<SearchIndexSettings />);
    const toggle = screen.getByTestId('search-index-image-text');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexImageText).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexImageText).toBe(true);
  });

  it('rebuilds the index on request', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-rebuild'));
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('says so when the index is unavailable', async () => {
    statusReply = { available: false };
    render(<SearchIndexSettings />);
    expect(await screen.findByText(/The index is not available right now/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('search-index-status')).toBeNull();
  });

  it('follows progress events', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => expect(statusText()).toContain('12 / 40'));
    act(() => progress({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096, complete: true }));
    expect(statusText()).toBe(`40 / 40 indexed · ${formatBytes(4096)}`);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('asks before deleting, then turns indexing off and deletes', async () => {
    // Record what the store said the instant destroy() was called, not after
    // the mock's promise settles: a reorder that moved the `false` write
    // below `await destroy()` would still leave the store `false` by the
    // time this test's later assertions run, but this catches it live.
    let enabledAtDestroy;
    destroy.mockImplementation(async () => {
      enabledAtDestroy = useSettingsStore.getState().searchIndexEnabled;
      return { ok: true };
    });
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(formatBytes(2048));
    expect(destroy).not.toHaveBeenCalled();
    const buttons = dialog.querySelectorAll('button');
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    expect(enabledAtDestroy).toBe(false);
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('cancelling the confirm deletes nothing', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(dialog.querySelectorAll('button')[dialog.querySelectorAll('button').length - 2]);
    expect(destroy).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(true);
  });

  it('when off, says so and offers Build, which turns indexing back on', async () => {
    useSettingsStore.setState({ searchIndexEnabled: false });
    statusReply = { available: false, state: 'off', indexed: 0, total: 0, sizeBytes: 0, complete: false, firstPassDone: false };
    render(<SearchIndexSettings />);
    expect(await screen.findByTestId('search-index-off')).toBeTruthy();
    expect(screen.queryByTestId('search-index-delete')).toBeNull();
    expect(screen.queryByTestId('search-index-rebuild')).toBeNull();
    fireEvent.click(screen.getByTestId('search-index-build'));
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(true);
  });

  it('a busy vault restores indexing and shows why', async () => {
    destroy.mockResolvedValue({ ok: false, error: 'searchIndex.busy' });
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    const buttons = dialog.querySelectorAll('button');
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    await waitFor(() => expect(screen.getByTestId('search-index-error').textContent).toBe('Your mail storage is being moved. Try again when that finishes.'));
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(true);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
  });

  it('a failed delete keeps indexing off and shows why', async () => {
    destroy.mockResolvedValue({ ok: false, error: 'searchIndex.destroyFailed' });
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    const buttons = dialog.querySelectorAll('button');
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    await waitFor(() => expect(screen.getByTestId('search-index-error')).toBeTruthy());
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(false);
  });

  it('an unreachable daemon restores indexing and shows the translated error', async () => {
    const daemonError = new Error('MailVault’s background service is not responding. Restart MailVault and try again.');
    daemonError.code = 'DAEMON_UNAVAILABLE';
    destroy.mockRejectedValue(daemonError);
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    const buttons = dialog.querySelectorAll('button');
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    await waitFor(() => expect(screen.getByTestId('search-index-error').textContent).toBe(daemonError.message));
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(true);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
  });
});
