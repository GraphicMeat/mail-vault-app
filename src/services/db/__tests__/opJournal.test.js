/**
 * The op journal is what survives a session that dies mid-mutation, so the
 * wrappers have exactly two jobs: send the shape Rust deserialises into
 * `OpEntry`, and never throw. A journal write that rejects must not take the
 * delete the user just confirmed down with it — losing a retry is recoverable,
 * an exception thrown out of the optimistic-update path is not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queueOp, clearOps, readOps } from '../opJournal.js';

if (!globalThis.window) globalThis.window = {};

let invoke;

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(undefined);
  window.__TAURI__ = { core: { invoke } };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__TAURI__;
});

describe('queueOp', () => {
  it('sends the entry shape the Rust side deserialises, and answers with its id', async () => {
    invoke.mockResolvedValue(7);

    const id = await queueOp({ op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4], arg: { flags: ['\\Seen'], action: 'add' } });

    expect(id).toBe(7);
    expect(invoke).toHaveBeenCalledWith('op_journal_queue', {
      entry: { id: 0, op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4], arg: { flags: ['\\Seen'], action: 'add' }, at: 0 },
    });
  });

  it('defaults arg to an empty object — a delete carries no argument', async () => {
    await queueOp({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [1] });

    expect(invoke.mock.calls[0][1].entry.arg).toEqual({});
  });

  // Nothing to journal is not a failure, and an empty entry would be a row in
  // the journal that every later replay has to step over.
  it('journals nothing and answers null when there are no uids', async () => {
    expect(await queueOp({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [] })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('answers null instead of throwing when the journal write fails', async () => {
    invoke.mockRejectedValue(new Error('disk full'));

    await expect(queueOp({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [1] })).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('clearOps', () => {
  it('names the op as well as the mailbox — a flag entry is not a delete entry', async () => {
    await clearOps({ op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [9], arg: { target: 'Archive' } });

    expect(invoke).toHaveBeenCalledWith('op_journal_clear', { op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [9], arg: { target: 'Archive' } });
  });

  // The flag path writes one entry per (flag, action), so a star and a
  // mark-read on one message are two entries under the same op, account,
  // mailbox and uid. Clearing without the arg emptied both, and the one that
  // had not been sent was dropped without a trace.
  it('names the arg too — a star is not a mark-read', async () => {
    await clearOps({ op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [7], arg: { flags: ['\\Seen'], action: 'add' } });

    expect(invoke.mock.calls[0][1].arg).toEqual({ flags: ['\\Seen'], action: 'add' });
  });

  it('defaults arg to an empty object — the shape a delete was queued with', async () => {
    await clearOps({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [1] });

    expect(invoke.mock.calls[0][1].arg).toEqual({});
  });

  it('warns and resolves when the clear fails', async () => {
    invoke.mockRejectedValue(new Error('nope'));

    await expect(clearOps({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [1] })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('readOps', () => {
  it('passes the journal through', async () => {
    const ops = [{ id: 0, op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [1], arg: {}, at: 1 }];
    invoke.mockResolvedValue(ops);

    expect(await readOps()).toEqual(ops);
  });

  // The replay iterates the answer, so anything that is not a list has to
  // become one here rather than throwing inside the launch path.
  it('answers an empty list for a non-list reply or a failed read', async () => {
    invoke.mockResolvedValue(null);
    expect(await readOps()).toEqual([]);

    invoke.mockRejectedValue(new Error('nope'));
    expect(await readOps()).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});
