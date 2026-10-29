// @vitest-environment jsdom
//
// The list a user goes looking for when a delete never stuck: every server op
// still owed, why it last failed, and a way to give up on one that has been
// failing for weeks.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockReadOps = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockClearOps = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockOpFailures = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const mockReplayOps = vi.hoisted(() => vi.fn().mockResolvedValue({ attempted: 1, done: 1, failed: 0, kept: 0 }));

vi.mock('../../../services/db', () => ({
  readOps: (...a) => mockReadOps(...a),
  clearOps: (...a) => mockClearOps(...a),
  opFailures: (...a) => mockOpFailures(...a),
  failureKey: ({ op, accountId, mailbox, uid }) => `${op}|${accountId}|${mailbox}|${uid}`,
}));
vi.mock('../../../services/workflows/replayOps', () => ({ replayOps: (...a) => mockReplayOps(...a) }));

import { PendingActionsSettings } from '../PendingActionsSettings';
import { useMailStore } from '../../../stores/mailStore';

const entry = (over = {}) => ({ id: 1, op: 'delete', accountId: 'acct-a', mailbox: 'INBOX', uids: [7, 9], arg: {}, at: Date.now() - 3600_000, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockReadOps.mockResolvedValue([]);
  mockOpFailures.mockReturnValue(new Map());
  useMailStore.setState({ accounts: [{ id: 'acct-a', email: 'a@mock.test' }] });
});
afterEach(cleanup);

describe('pending actions', () => {
  it('says so when nothing is owed', async () => {
    render(<PendingActionsSettings />);
    expect(await screen.findByText(/Nothing is waiting/i)).toBeTruthy();
  });

  it('lists an owed delete with its account, folder, message count and last error', async () => {
    mockReadOps.mockResolvedValue([entry()]);
    mockOpFailures.mockReturnValue(new Map([['delete|acct-a|INBOX|7', { message: 'socket closed', at: Date.now() }]]));

    render(<PendingActionsSettings />);

    expect(await screen.findByText(/a@mock\.test/)).toBeTruthy();
    expect(screen.getByText(/INBOX/)).toBeTruthy();
    expect(screen.getByText(/2 messages/i)).toBeTruthy();
    expect(screen.getByText(/socket closed/)).toBeTruthy();
  });

  it('cancels an entry by its full identity and drops it from the list', async () => {
    mockReadOps.mockResolvedValue([entry()]);
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);

    mockReadOps.mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });

    expect(mockClearOps).toHaveBeenCalledWith({ op: 'delete', accountId: 'acct-a', mailbox: 'INBOX', uids: [7, 9], arg: {} });
    await waitFor(() => expect(screen.queryByText(/a@mock\.test/)).toBeNull());
  });

  it('retries everything owed on demand and re-reads the journal', async () => {
    mockReadOps.mockResolvedValue([entry()]);
    render(<PendingActionsSettings />);
    await screen.findByText(/a@mock\.test/);
    mockReadOps.mockClear();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });

    expect(mockReplayOps).toHaveBeenCalledWith({ reason: 'manual' });
    await waitFor(() => expect(mockReadOps).toHaveBeenCalled());
  });
});

describe('a delete of several messages', () => {
  it('keeps every message listed and says which went and which did not', async () => {
    mockReadOps.mockResolvedValue([entry({
      uids: [9, 11],
      arg: { total: 3, messages: [
        { uid: 7, subject: 'Invoice March', from: 'Shop' },
        { uid: 9, subject: 'Weekly digest', from: 'News' },
        { uid: 11, subject: '', from: 'Bank' },
      ] },
    })]);
    mockOpFailures.mockReturnValue(new Map([['delete|acct-a|INBOX|9', { message: 'NO server busy', at: Date.now() }]]));

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
    mockReadOps.mockResolvedValue([entry()]);
    mockOpFailures.mockReturnValue(new Map([['delete|acct-a|INBOX|7', {
      message: 'E_JMAP_NO_TRASH: the account has no Trash mailbox to move UID 7 from INBOX into', at: Date.now(),
    }]]));

    render(<PendingActionsSettings />);

    expect(await screen.findByText('This account has no Trash folder, so nothing was deleted.')).toBeTruthy();
    expect(screen.queryByText(/E_JMAP_NO_TRASH/)).toBeNull();
  });
});
