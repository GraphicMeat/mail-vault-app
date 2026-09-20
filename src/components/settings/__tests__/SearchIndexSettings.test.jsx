// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let statusReply;
let progress = null;
const rebuild = vi.fn();
const destroy = vi.fn();
const status = vi.fn();
let reconnect = null;
let deferSubscriptions = false;
let pendingProgressSubscriptions = [];
let pendingReconnectSubscriptions = [];
const progressListeners = new Set();
const reconnectListeners = new Set();
const subscribe = (listeners, pending, callback, onRemove) => {
  listeners.add(callback);
  const release = () => {
    listeners.delete(callback);
    onRemove();
  };
  if (deferSubscriptions) return new Promise(resolve => pending.push({ callback, resolve: () => resolve(release) }));
  return Promise.resolve(release);
};
vi.mock('../../../services/searchIndex', () => ({
  status: (...args) => status(...args),
  rebuild: (...args) => rebuild(...args),
  destroy: (...args) => destroy(...args),
  onProgress: cb => {
    progress = cb;
    return subscribe(progressListeners, pendingProgressSubscriptions, cb, () => { if (progress === cb) progress = null; });
  },
  onDaemonReconnected: cb => {
    reconnect = cb;
    return subscribe(reconnectListeners, pendingReconnectSubscriptions, cb, () => { if (reconnect === cb) reconnect = null; });
  },
}));

import { SearchIndexSettings } from '../SearchIndexSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
import { formatBytes } from '../../../utils/formatBytes';

const statusText = () => screen.getByTestId('search-index-status').textContent;

beforeEach(() => {
  statusReply = { available: true, state: 'indexing', indexed: 12, total: 40, sizeBytes: 2048, complete: false };
  progress = null;
  reconnect = null;
  deferSubscriptions = false;
  pendingProgressSubscriptions = [];
  pendingReconnectSubscriptions = [];
  progressListeners.clear();
  reconnectListeners.clear();
  status.mockReset().mockImplementation(() => Promise.resolve(statusReply));
  rebuild.mockReset().mockResolvedValue(undefined);
  destroy.mockReset().mockResolvedValue({ ok: true });
  useSettingsStore.setState({
    billingProfile: null,
    searchMailboxConcurrency: 3,
    searchIndexBodies: true,
    searchIndexAttachments: true,
    searchIndexImageText: true,
    searchIndexEnabled: true,
  });
});
afterEach(cleanup);

describe('Search index settings', () => {
  it('shows how much is indexed, its size, and a progress bar while indexing', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => expect(statusText()).toBe(`12 / 40 indexed · ${formatBytes(2048)}`));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByTestId('search-index-rebuild').disabled).toBe(false);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
  });

  it('shows free users one mailbox at a time without changing their saved preference', () => {
    useSettingsStore.setState({ billingProfile: null, searchMailboxConcurrency: 4 });
    const onUpgrade = vi.fn();
    render(<SearchIndexSettings onUpgrade={onUpgrade} />);

    const select = screen.getByTestId('search-mailbox-concurrency');
    expect(select.value).toBe('1');
    expect(select.disabled).toBe(true);
    expect(useSettingsStore.getState().searchMailboxConcurrency).toBe(4);
    fireEvent.click(screen.getByTestId('search-concurrency-upgrade'));
    expect(onUpgrade).toHaveBeenCalledOnce();
  });

  it('lets Premium save any mailbox concurrency from one through five', () => {
    useSettingsStore.setState({
      billingProfile: { hasSubscription: true, status: 'active' },
      searchMailboxConcurrency: 3,
    });
    render(<SearchIndexSettings onUpgrade={vi.fn()} />);

    const select = screen.getByTestId('search-mailbox-concurrency');
    expect(select.value).toBe('3');
    expect(select.disabled).toBe(false);
    for (const value of [1, 2, 3, 4, 5]) {
      fireEvent.change(select, { target: { value: String(value) } });
      expect(useSettingsStore.getState().searchMailboxConcurrency).toBe(value);
    }
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
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
  });

  it('keeps a rebuild rejection visible after a healthy status refresh', async () => {
    const failure = new Error('The vault folder is read-only. Check its permissions and retry.');
    rebuild.mockRejectedValue(failure);
    status.mockResolvedValueOnce(statusReply).mockResolvedValueOnce({
      available: true,
      state: 'idle',
      indexed: 40,
      total: 40,
      sizeBytes: 4096,
    });
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-rebuild'));

    expect((await screen.findByTestId('search-index-error')).textContent).toContain(failure.message);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('search-index-status').textContent).toContain('40 / 40'));
    expect(screen.getByTestId('search-index-error').textContent).toContain(failure.message);
  });

  it('shows a rebuild error returned in the response', async () => {
    rebuild.mockResolvedValue({ ok: false, error: 'searchIndex.recoveryFailed' });
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-rebuild'));

    expect((await screen.findByTestId('search-index-error')).textContent).toContain('The search index could not be repaired. Check that the vault is available and try again.');
  });

  it('shows automatic recovery instead of permanent unavailability when enabled status is missing', async () => {
    statusReply = { available: false };
    render(<SearchIndexSettings />);
    expect((await screen.findByTestId('search-index-status-message')).textContent).toContain('The search index is recovering automatically. Search reads the vault directly while it repairs.');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('search-index-status')).toBeNull();
  });

  it('keeps rebuild and delete available when the index is unavailable', async () => {
    statusReply = { available: false, state: 'recovering' };
    render(<SearchIndexSettings />);
    expect((await screen.findByTestId('search-index-status-message')).textContent).toContain('The search index is recovering automatically. Search reads the vault directly while it repairs.');

    const rebuildButton = screen.getByTestId('search-index-rebuild');
    const deleteButton = screen.getByTestId('search-index-delete');
    expect(rebuildButton.disabled).toBe(false);
    expect(deleteButton.disabled).toBe(false);

    fireEvent.click(rebuildButton);
    await waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      const buttons = dialog.querySelectorAll('button');
      fireEvent.click(buttons[buttons.length - 1]);
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('shows the outdated background service message when status carries that error', async () => {
    statusReply = { available: false, state: 'error', errorKey: 'errors.daemonOutdated' };
    render(<SearchIndexSettings />);
    expect(await screen.findByText("MailVault's background service is out of date. Quit and reopen MailVault.")).toBeTruthy();
    expect(screen.queryByText(/The index is not available right now/)).toBeNull();
  });

  it('shows automatic recovery for an enabled index that is recovering', async () => {
    statusReply = { available: false, state: 'recovering' };
    render(<SearchIndexSettings />);

    expect((await screen.findByTestId('search-index-status-message')).textContent).toContain('The search index is recovering automatically. Search reads the vault directly while it repairs.');
    expect(screen.getByTestId('search-index-rebuild').disabled).toBe(false);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
  });

  it('shows a starting state while the enabled index is opening', async () => {
    statusReply = { available: false, state: 'starting' };
    render(<SearchIndexSettings />);

    expect((await screen.findByTestId('search-index-status-message')).textContent).toContain('The search index is starting. Search reads the vault directly until it is ready.');
  });

  it('keeps recovery controls enabled for an error state and shows its cause', async () => {
    statusReply = {
      available: true,
      state: 'error',
      errorKey: 'searchIndex.recoveryFailed',
      errorDetail: 'The vault folder is read-only. Check its permissions and retry.',
    };
    render(<SearchIndexSettings />);

    expect((await screen.findByTestId('search-index-status-message')).textContent).toContain('The search index could not be repaired. Check that the vault is available and try again. The vault folder is read-only. Check its permissions and retry.');
    expect(screen.getByTestId('search-index-rebuild').disabled).toBe(false);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
  });

  it('refreshes status after a daemon reconnect without replacing newer progress', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    await waitFor(() => expect(typeof reconnect).toBe('function'));
    status.mockClear().mockResolvedValue({ available: false, state: 'recovering' });
    await act(async () => { reconnect?.(); });
    await waitFor(() => expect(status).toHaveBeenCalledOnce());
    expect((await screen.findByTestId('search-index-status-message')).textContent).toContain('The search index is recovering automatically. Search reads the vault directly while it repairs.');

    let resolveRefresh;
    status.mockClear().mockImplementation(() => new Promise(resolve => { resolveRefresh = resolve; }));
    await act(async () => { reconnect?.(); });
    act(() => progress({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096, complete: true }));
    await waitFor(() => expect(status).toHaveBeenCalledOnce());
    await act(async () => { resolveRefresh({ available: false, state: 'error', errorKey: 'searchIndex.recoveryFailed' }); });
    expect(screen.getByTestId('search-index-status').textContent).toContain('40 / 40');
    expect(screen.queryByTestId('search-index-status-message')).toBeNull();
  });

  it('unlistens deferred StrictMode subscriptions from the discarded effect', async () => {
    deferSubscriptions = true;
    const { unmount } = render(
      <React.StrictMode>
        <SearchIndexSettings />
      </React.StrictMode>
    );
    await waitFor(() => {
      expect(pendingProgressSubscriptions).toHaveLength(2);
      expect(pendingReconnectSubscriptions).toHaveLength(2);
    });

    const [staleProgress, activeProgress] = pendingProgressSubscriptions.map(item => item.callback);
    const [staleReconnect, activeReconnect] = pendingReconnectSubscriptions.map(item => item.callback);
    await act(async () => {
      pendingProgressSubscriptions.forEach(item => item.resolve());
      pendingReconnectSubscriptions.forEach(item => item.resolve());
    });
    expect(progressListeners.size).toBe(1);
    expect(reconnectListeners.size).toBe(1);
    await waitFor(() => expect(statusText()).toContain('12 / 40'));

    act(() => staleProgress({ available: true, state: 'idle', indexed: 1, total: 1, sizeBytes: 1 }));
    expect(statusText()).toContain('12 / 40');
    status.mockClear();
    await act(async () => { staleReconnect?.(); });
    expect(status).not.toHaveBeenCalled();
    await act(async () => { activeReconnect?.(); });
    expect(status).toHaveBeenCalledOnce();
    act(() => activeProgress({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096 }));
    expect(statusText()).toContain('40 / 40');

    unmount();
    expect(progressListeners.size).toBe(0);
    expect(reconnectListeners.size).toBe(0);
  });

  it('applies only the newest overlapping status reply', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    await waitFor(() => expect(typeof reconnect).toBe('function'));
    const replies = [];
    status.mockClear().mockImplementation(() => new Promise(resolve => replies.push(resolve)));

    await act(async () => { reconnect?.(); reconnect?.(); });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await act(async () => {
      replies[1]({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096 });
    });
    expect(screen.getByTestId('search-index-status').textContent).toContain('40 / 40');
    await act(async () => {
      replies[0]({ available: false, state: 'error', errorKey: 'searchIndex.recoveryFailed' });
    });
    expect(screen.getByTestId('search-index-status').textContent).toContain('40 / 40');
    expect(screen.queryByTestId('search-index-status-message')).toBeNull();
  });

  it('ignores pre-action status replies and clears the action error after a fresh healthy status', async () => {
    const rebuildFailure = new Error('The rebuild request failed. Check the vault and retry.');
    rebuild.mockRejectedValue(rebuildFailure);
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    await waitFor(() => expect(typeof reconnect).toBe('function'));
    const replies = [];
    status.mockClear().mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    await act(async () => { reconnect?.(); });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('search-index-rebuild'));
    expect((await screen.findByTestId('search-index-error')).textContent).toContain(rebuildFailure.message);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await act(async () => {
      replies[0]({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096 });
    });
    expect(screen.getByTestId('search-index-error').textContent).toContain(rebuildFailure.message);

    await act(async () => {
      replies[1]({ available: false, state: 'error', errorKey: 'searchIndex.recoveryFailed' });
    });
    await act(async () => { reconnect?.(); });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    await act(async () => {
      replies[2]({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096 });
    });
    expect(screen.queryByTestId('search-index-error')).toBeNull();
    expect(screen.queryByTestId('search-index-status-message')).toBeNull();
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
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
    expect(screen.getByTestId('search-index-build').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('search-index-build'));
    await waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
    expect(useSettingsStore.getState().searchIndexEnabled).toBe(true);
  });

  it('keeps an already-off index off when Delete fails as busy', async () => {
    useSettingsStore.setState({ searchIndexEnabled: false });
    statusReply = { available: false, state: 'off', indexed: 0, total: 0, sizeBytes: 0 };
    destroy.mockResolvedValue({ ok: false, error: 'searchIndex.busy' });
    render(<SearchIndexSettings />);
    await screen.findByTestId('search-index-off');
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(dialog.querySelectorAll('button')[dialog.querySelectorAll('button').length - 1]); });

    expect(useSettingsStore.getState().searchIndexEnabled).toBe(false);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
    expect(screen.getByTestId('search-index-error')).toBeTruthy();
  });

  it('keeps an already-off index off when Delete fails with an I/O error', async () => {
    useSettingsStore.setState({ searchIndexEnabled: false });
    statusReply = { available: false, state: 'off' };
    destroy.mockResolvedValue({ ok: false, error: 'searchIndex.destroyFailed' });
    render(<SearchIndexSettings />);
    await screen.findByTestId('search-index-off');
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(dialog.querySelectorAll('button')[dialog.querySelectorAll('button').length - 1]); });

    expect(useSettingsStore.getState().searchIndexEnabled).toBe(false);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
    expect(screen.getByTestId('search-index-error')).toBeTruthy();
  });

  it('coalesces repeated Delete confirms while restoring the modal loading guard', async () => {
    let resolveDestroy;
    destroy.mockImplementation(() => new Promise(resolve => { resolveDestroy = resolve; }));
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    let dialog = await screen.findByRole('alertdialog');
    const confirm = dialog.querySelectorAll('button')[dialog.querySelectorAll('button').length - 1];
    fireEvent.click(confirm);
    expect(screen.getByTestId('search-index-delete').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('search-index-delete'));
    dialog = await screen.findByRole('alertdialog');
    const repeatedConfirm = dialog.querySelectorAll('button')[dialog.querySelectorAll('button').length - 1];
    expect(repeatedConfirm.disabled).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();

    await act(async () => { resolveDestroy({ ok: true }); });
  });

  it('links every visible Premium hint to the Billing callback for free users', () => {
    const onUpgrade = vi.fn();
    render(<SearchIndexSettings onUpgrade={onUpgrade} />);
    const links = screen.getAllByRole('button', { name: 'Premium' });
    expect(links).toHaveLength(2);
    for (const link of links) fireEvent.click(link);
    expect(onUpgrade).toHaveBeenCalledTimes(2);
  });

  it('links paid concurrency and feature Premium hints to Billing', () => {
    useSettingsStore.setState({ billingProfile: { hasSubscription: true, status: 'active' } });
    const onUpgrade = vi.fn();
    render(<SearchIndexSettings onUpgrade={onUpgrade} />);
    const links = screen.getAllByRole('button', { name: 'Premium' });
    expect(links).toHaveLength(3);
    for (const link of links) fireEvent.click(link);
    expect(onUpgrade).toHaveBeenCalledTimes(3);
  });

  it('renders the translated Premium label inside the hint link', async () => {
    const { setLocale } = await import('../../../i18n/index.js');
    await setLocale('zh-Hans');
    const onUpgrade = vi.fn();
    render(<SearchIndexSettings onUpgrade={onUpgrade} />);
    const premium = screen.getAllByRole('button', { name: '高级版' });
    expect(premium).toHaveLength(2);
    premium[0].focus();
    expect(document.activeElement).toBe(premium[0]);
    fireEvent.click(premium[0]);
    expect(onUpgrade).toHaveBeenCalledOnce();
    await setLocale('en');
  });

  it('clears the displayed recovery failure after healthy progress', async () => {
    statusReply = { available: false, state: 'error', errorKey: 'searchIndex.recoveryFailed' };
    render(<SearchIndexSettings />);
    await screen.findByTestId('search-index-status-message');
    act(() => progress({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096, complete: true }));
    expect(screen.queryByTestId('search-index-status-message')).toBeNull();
  });

  it('a busy vault restores indexing and shows why', async () => {
    destroy.mockResolvedValue({ ok: false, error: 'searchIndex.busy' });
    status.mockResolvedValueOnce(statusReply).mockResolvedValueOnce({
      available: true,
      state: 'idle',
      indexed: 40,
      total: 40,
      sizeBytes: 4096,
    });
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-delete'));
    const dialog = await screen.findByRole('alertdialog');
    const buttons = dialog.querySelectorAll('button');
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    await waitFor(() => expect(statusText()).toContain('40 / 40'));
    expect(screen.getByTestId('search-index-error').textContent).toBe('Your mail storage is being moved. Try again when that finishes.');
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
