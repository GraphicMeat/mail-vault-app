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
