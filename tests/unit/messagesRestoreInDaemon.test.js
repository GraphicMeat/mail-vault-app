// The undo of a delete is the daemon's (`messages.restore`); the app only
// reaches it by name, and the demo answers it without a server.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DAEMON_OWNED } from '../../src/services/transport.js';
import { createDemoBackend } from '../../src/demo/backend.js';

it('routes messages.restore to the daemon, which implements it and lets the index yield to it', () => {
  expect(DAEMON_OWNED.has('messages.restore')).toBe(true);
  const deleted = readFileSync('src-daemon/src/handlers/deleted.rs', 'utf8');
  expect(deleted).toContain('"messages.restore"');
  expect(readFileSync('src-daemon/src/server.rs', 'utf8')).toContain('crate::handlers::deleted::route(');
  expect(readFileSync('src-daemon/src/search_index.rs', 'utf8')).toMatch(/is_foreground_method[\s\S]*"messages\.restore"/);
  // A user-facing call that can talk to the server: a finite reply budget.
  expect(readFileSync('src-tauri/src/main.rs', 'utf8')).toMatch(/"messages\.restore" => Some\(Duration::from_secs\(\d+\)\)/);
});

it('the demo puts a message deleted to Trash back, by its Trash uid or its Message-ID', async () => {
  for (const byMessageId of [false, true]) {
    const demo = createDemoBackend();
    const target = demo.snapshot().messages.find(m => m.custody === 'server' && m.messageId);
    const { accountId, mailbox, uid, messageId } = target;
    const out = await demo.invoke('imap_delete_email', { accountId, mailbox, uid, mode: 'trash' });
    expect(out.trash).toBe('Trash');

    const reply = await demo.invoke('messages.restore', {
      items: [{ accountId, mailbox, uid, trash: out.trash, trashUid: byMessageId ? null : out.trashUid, messageId, binId: null }],
    });

    expect(reply.failed).toEqual([]);
    expect(reply.restored).toEqual([{ accountId, mailbox, uid, newUid: out.trashUid }]);
    expect(demo.snapshot().messages.some(m => m.accountId === accountId && m.mailbox === 'Trash' && m.uid === out.trashUid)).toBe(false);
  }
});

// The app's path: a DAEMON_OWNED name reaches the demo as `daemon_rpc`.
it('the demo answers messages.restore when it arrives the way the app sends it', async () => {
  const demo = createDemoBackend();
  const target = demo.snapshot().messages.find(m => m.custody === 'server' && m.messageId);
  const { accountId, mailbox, uid, messageId } = target;
  const out = await demo.invoke('imap_delete_email', { accountId, mailbox, uid, mode: 'trash' });
  const reply = await demo.invoke('daemon_rpc', { method: 'messages.restore', params: {
    items: [{ accountId, mailbox, uid, trash: out.trash, trashUid: out.trashUid, messageId, binId: null }],
  } });
  expect(reply).toEqual({ restored: [{ accountId, mailbox, uid, newUid: out.trashUid }], failed: [] });
});

it('the demo says, in catalog words, that a copy Trash no longer holds cannot come back', async () => {
  const demo = createDemoBackend();
  const reply = await demo.invoke('messages.restore', {
    items: [{ accountId: 'nobody', mailbox: 'INBOX', uid: 404, trash: 'Trash', trashUid: 9, messageId: '<x@y>', binId: null }],
  });
  expect(reply).toEqual({ restored: [], failed: [{ accountId: 'nobody', mailbox: 'INBOX', uid: 404, error: 'deletedBin.goneFromTrash' }] });
});
