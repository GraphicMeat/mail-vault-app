// The daemon owns the durable delete queue; the app only reaches it by name.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DAEMON_OWNED } from '../../src/services/transport.js';
import { createDemoBackend } from '../../src/demo/backend.js';

const COMMANDS = ['delete_queue.submit', 'delete_queue.list', 'delete_queue.cancel', 'delete_queue.run'];

it('routes the delete queue to the daemon, which implements every command', () => {
  const daemon = readFileSync('src-daemon/src/delete_queue.rs', 'utf8');
  const server = readFileSync('src-daemon/src/server.rs', 'utf8');
  for (const command of COMMANDS) {
    expect(DAEMON_OWNED.has(command), command).toBe(true);
    expect(daemon).toContain(`"${command}"`);
  }
  expect(server).toContain('crate::delete_queue::route(');
});

it('the demo lands a submit at once and cancels a queued entry by id', async () => {
  const demo = createDemoBackend();
  const reply = await demo.invoke('delete_queue.submit', { accountId: 'nobody', mailbox: 'INBOX', uids: [404], mode: 'auto' });
  expect(reply).toEqual({ landed: [{ kind: 'deleted', uid: 404, trash: null, trashUid: null, binId: null }], queued: [], dropped: [] });

  const id = await demo.invoke('op_journal_queue', { entry: { op: 'delete', accountId: 'a', mailbox: 'INBOX', uids: [1, 2], arg: {} } });
  expect(await demo.invoke('delete_queue.list')).toEqual([expect.objectContaining({ id, uids: [1, 2], attempts: 0, failures: {} })]);
  await demo.invoke('delete_queue.cancel', { id, uids: [1] });
  expect((await demo.invoke('delete_queue.list'))[0].uids).toEqual([2]);
  await demo.invoke('delete_queue.cancel', { id, uids: [2] });
  expect(await demo.invoke('delete_queue.list')).toEqual([]);
});

it('the demo replay pass lands what the journal owes and answers its counts', async () => {
  const demo = createDemoBackend();
  await demo.invoke('op_journal_queue', { entry: { op: 'delete', accountId: 'a', mailbox: 'INBOX', uids: [1, 2], arg: {} } });
  expect(await demo.invoke('delete_queue.run', { reason: 'manual' })).toEqual({ attempted: 2, done: 2, failed: 0, dropped: 0, skipped: 0, kept: 0 });
  expect(await demo.invoke('delete_queue.list')).toEqual([]);
  expect(await demo.invoke('delete_queue.run', {})).toEqual({ attempted: 0, done: 0, failed: 0, dropped: 0, skipped: 0, kept: 0 });
});
