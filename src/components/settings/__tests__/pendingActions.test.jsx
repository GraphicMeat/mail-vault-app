// @vitest-environment jsdom
//
// The list a user goes looking for when a delete never stuck: every server op
// still owed, why it last failed, and a way to give up on one that has been
// failing for weeks. Deletes are the daemon's queue (`delete_queue.list`,
// with their attempts and reasons, which survive a restart); flags, moves and
// purges are still the app's journal.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockReadOps = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockClearOps = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockOpFailures = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const mockReplayOps = vi.hoisted(() => vi.fn().mockResolvedValue({ attempted: 1, done: 1, failed: 0, kept: 0 }));
const mockQueueList = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockQueueCancel = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockQueueRun = vi.hoisted(() => vi.fn().mockResolvedValue({ attempted: 0, done: 0, failed: 0, dropped: 0, skipped: 0, kept: 0 }));
const listeners = vi.hoisted(() => new Map());

vi.mock('../../../services/db', () => ({
  readOps: (...a) => mockReadOps(...a),
  clearOps: (...a) => mockClearOps(...a),
  opFailures: (...a) => mockOpFailures(...a),
  failureKey: ({ op, accountId, mailbox, uid }) => `${op}|${accountId}|${mailbox}|${uid}`,
}));
vi.mock('../../../services/workflows/replayOps', () => ({ replayOps: (...a) => mockReplayOps(...a) }));
vi.mock('../../../services/api', () => ({
  deleteQueueList: (...a) => mockQueueList(...a),
  deleteQueueCancel: (...a) => mockQueueCancel(...a),
  deleteQueueRun: (...a) => mockQueueRun(...a),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); },
}));

import { PendingActionsSettings } from '../PendingActionsSettings';
import { useMailStore } from '../../../stores/mailStore';
import '../../../services/workflows/bindStoreActions';

const entry = (over = {}) => ({ id: 1, op: 'delete', accountId: 'acct-a', mailbox: 'INBOX', uids: [7, 9], arg: {}, at: Date.now() - 3600_000, attempts: 1, failures: {}, ...over });
const failure = (message) => ({ message, at: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  mockReadOps.mockResolvedValue([]);
  mockQueueList.mockResolvedValue([]);
  mockOpFailures.mockReturnValue(new Map());
  useMailStore.setState({ accounts: [{ id: 'acct-a', email: 'a@mock.test' }], deleteTombstones: new Set(), loadEmails: vi.fn() });
});
afterEach(cleanup);

describe('pending actions', () => {
  it('says so when nothing is owed', async () => {
    render(<PendingActionsSettings />);
    expect(await screen.findByText(/Nothing is waiting/i)).toBeTruthy();
  });

  it('lists an owed delete with its account, folder, message count, tries and last error, from the daemon queue', async () => {
    mockQueueList.mockResolvedValue([entry({ attempts: 3, failures: { 7: failure('socket closed') } })]);

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/a@mock\.test/)).toBeTruthy();
    expect(screen.getByText(/INBOX/)).toBeTruthy();
    expect(screen.getByText(/2 messages/i)).toBeTruthy();
    expect(screen.getByText(/socket closed/)).toBeTruthy();
    expect(screen.getByText(/Tried 3 times/)).toBeTruthy();
  });

  it('says a delete never tried yet is waiting, not that it failed', async () => {
    mockQueueList.mockResolvedValue([entry({ attempts: 0, failures: {} })]);

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/Not tried yet/)).toBeTruthy();
    expect(screen.queryByText(/Tried \d+ time/)).toBeNull();
  });

  it('lists a delete once, from the queue, even though the journal holds it too', async () => {
    mockQueueList.mockResolvedValue([entry()]);
    mockReadOps.mockResolvedValue([entry(), entry({ id: 2, op: 'move', uids: [4], arg: { target: 'Archive' } })]);

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/Delete from server/)).toBeTruthy();
    expect(screen.getAllByText(/Delete from server/)).toHaveLength(1);
    expect(screen.getByText(/Move to another folder/)).toBeTruthy();
  });

  it('cancels a queued delete by its id, shows its rows again and drops it from the list', async () => {
    mockQueueList.mockResolvedValue([entry()]);
    useMailStore.setState({ deleteTombstones: new Set(['acct-a|INBOX|7', 'acct-a|INBOX|9']) });
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);

    mockQueueList.mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });

    expect(mockQueueCancel).toHaveBeenCalledWith(1, [7, 9]);
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(useMailStore.getState().deleteTombstones.size).toBe(0);
    await waitFor(() => expect(screen.queryByText(/a@mock\.test/)).toBeNull());
  });

  it('cancels a journalled move by its full identity', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [4], arg: { target: 'Archive' } })]);
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);

    mockReadOps.mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });

    expect(mockClearOps).toHaveBeenCalledWith({ op: 'move', accountId: 'acct-a', mailbox: 'INBOX', uids: [4], arg: { target: 'Archive' } });
    expect(mockQueueCancel).not.toHaveBeenCalled();
  });

  it('retries everything owed on demand without waiting for the daemon pass', async () => {
    mockQueueList.mockResolvedValue([entry()]);
    // A pass can take minutes; the list does not wait for it.
    mockQueueRun.mockReturnValue(new Promise(() => {}));
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);
    mockReadOps.mockClear();
    mockQueueList.mockClear();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });

    expect(mockQueueRun).toHaveBeenCalledWith({ reason: 'manual' });
    expect(mockReplayOps).toHaveBeenCalledWith({ reason: 'manual' });
    await waitFor(() => expect(mockReadOps).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i }).disabled).toBe(false));
  });

  it('re-reads the queue when the daemon says it changed', async () => {
    mockQueueList.mockResolvedValue([entry()]);
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);
    await waitFor(() => expect(listeners.has('delete-queue-changed')).toBe(true));

    mockQueueList.mockResolvedValue([]);
    await act(async () => { listeners.get('delete-queue-changed')({ payload: {} }); });

    await waitFor(() => expect(screen.queryByText(/a@mock\.test/)).toBeNull());
  });
});

describe('when the daemon cannot be asked', () => {
  it('says the queue could not be read instead of saying nothing is waiting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockQueueList.mockRejectedValue(new Error('daemon unreachable'));

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/could not read the deletes/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing is waiting/i)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the deletes it last read when a later read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockQueueList.mockResolvedValue([entry()]);
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);
    await waitFor(() => expect(listeners.has('delete-queue-changed')).toBe(true));

    mockQueueList.mockRejectedValue(new Error('daemon unreachable'));
    await act(async () => { listeners.get('delete-queue-changed')({ payload: {} }); });

    expect(await screen.findByText(/could not read the deletes/i)).toBeTruthy();
    expect(screen.getByText(/a@mock\.test/)).toBeTruthy();
    warn.mockRestore();
  });
});

describe('a delete the bulk tool queued', () => {
  it('shows the reason this session recorded when the daemon kept none', async () => {
    mockQueueList.mockResolvedValue([entry({ attempts: 0, failures: {} })]);
    mockOpFailures.mockReturnValue(new Map([['delete|acct-a|INBOX|7', { message: 'NO bulk refused', at: Date.now() }]]));

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/NO bulk refused/)).toBeTruthy();
    expect(screen.queryByText(/Not tried yet/)).toBeNull();
  });
});

describe('a delete of several messages', () => {
  it('keeps every message listed and says which went and which did not', async () => {
    mockQueueList.mockResolvedValue([entry({
      uids: [9, 11],
      arg: { total: 3, messages: [
        { uid: 7, subject: 'Invoice March', from: 'Shop' },
        { uid: 9, subject: 'Weekly digest', from: 'News' },
        { uid: 11, subject: '', from: 'Bank' },
      ], mode: 'auto', bin: true },
      failures: { 9: failure('NO server busy') },
    })]);

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/3 messages/i)).toBeTruthy();
    expect(screen.getByText(/1 deleted, 2 not yet/)).toBeTruthy();
    const line = (text) => screen.getByText(text).closest('li');
    expect(line('Invoice March').textContent).toMatch(/Deleted/);
    expect(line('Weekly digest').textContent).toMatch(/Not deleted yet/);
    expect(line(/No subject/i).textContent).toMatch(/Not deleted yet/);
  });

  it('marks a message the server refused as not deleted, not as gone', async () => {
    mockReadOps.mockResolvedValue([entry({
      op: 'purge',
      uids: [9],
      arg: { hints: [], total: 2, messages: [{ uid: 7, subject: 'Refused one', from: '' }, { uid: 9, subject: 'Owed one', from: '' }] },
    })]);
    mockOpFailures.mockReturnValue(new Map([['purge|acct-a|INBOX|7', { message: 'errors.bulkIdentityUncertain', at: Date.now() }]]));

    render(<PendingActionsSettings />);

    const refusedLine = (await screen.findByText('Refused one')).closest('li');
    expect(refusedLine.textContent).toMatch(/Not deleted$/);
    expect(screen.getByText('Owed one').closest('li').textContent).toMatch(/Not deleted yet/);
  });
});

describe('a JMAP refusal', () => {
  it('reads in the app\'s words, not the daemon\'s code', async () => {
    mockQueueList.mockResolvedValue([entry({ failures: {
      7: failure('E_JMAP_NO_TRASH: the account has no Trash mailbox to move UID 7 from INBOX into'),
    } })]);

    render(<PendingActionsSettings />);

    expect(await screen.findByText('This account has no Trash folder, so nothing was deleted.')).toBeTruthy();
    expect(screen.queryByText(/E_JMAP_NO_TRASH/)).toBeNull();
  });
});

// The server renumbered the folder: the daemon sent nothing, owes nothing
// (the rows show again), and keeps the entry and its reason until cancelled.
describe('a delete the server renumbering stopped', () => {
  const stopped = (over = {}) => entry({
    uids: [],
    arg: { total: 2, messages: [{ uid: 7, subject: 'Old invoice', from: 'Shop' }, { uid: 9, subject: 'Old digest', from: 'News' }], mode: 'auto', bin: true, uidValidity: 1 },
    failures: {
      7: { ...failure('errors.deleteQueueMailboxRenumbered'), stopped: true },
      9: { ...failure('errors.deleteQueueMailboxRenumbered'), stopped: true },
    },
    ...over,
  });

  it('says why, counts no message as deleted, and marks each as not deleted', async () => {
    mockQueueList.mockResolvedValue([stopped()]);

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/2 messages/i)).toBeTruthy();
    expect(screen.getByText(/renumbered on the server/i)).toBeTruthy();
    expect(screen.queryByText(/deleted, \d+ not yet/)).toBeNull();
    expect(screen.getByText('Old invoice').closest('li').textContent).toMatch(/Not deleted$/);
    expect(screen.getByText('Old digest').closest('li').textContent).toMatch(/Not deleted$/);
  });

  it('cancels the stopped messages too', async () => {
    mockQueueList.mockResolvedValue([stopped({ uids: [11], failures: { 7: { ...failure('errors.deleteQueueMailboxRenumbered'), stopped: true } } })]);
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);

    mockQueueList.mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });

    expect(mockQueueCancel).toHaveBeenCalledWith(1, [11, 7]);
  });
});
