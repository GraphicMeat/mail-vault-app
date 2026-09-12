import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoBackend } from '../backend.js';

afterEach(() => vi.useRealTimers());

describe('browser demo workflow contracts', () => {
  it('yields during the scheduler change-feed long poll', async () => {
    vi.useFakeTimers();
    const backend = createDemoBackend();
    let settled = false;
    const poll = backend.invoke('daemon_rpc', { method: 'sync.events', params: { since: 0, timeoutMs: 1000 } });
    poll.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(poll).resolves.toMatchObject({ gen: expect.any(Number), changes: [] });
  });

  it('autosaves changes into the same draft and reopens the latest body', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const location = { accountId: account.id, mailbox: 'Drafts', uid: 900001 };
    const raw = btoa('From: rowan@primecut.studio\nSubject: Marker test\n\nA sample');
    for (const text of ['First paragraph', 'Edited paragraph\n\nSecond paragraph']) {
      const built = await backend.invoke('smtp_build_draft_mime', {
        account, email: { to: 'nell@smokehouse.design', subject: 'Saved demo draft', text, html: `<p>${text}</p>` },
      });
      await backend.invoke('maildir_store', { ...location, rawSourceBase64: built.rawBase64, flags: ['archived', 'seen', 'draft'] });
    }
    const reopened = await backend.invoke('maildir_read', location);
    expect(reopened.text).toBe('Edited paragraph\n\nSecond paragraph');
    expect(reopened.to).toContainEqual(expect.objectContaining({ address: 'nell@smokehouse.design' }));
    const listed = await backend.invoke('maildir_list', { accountId: account.id, mailbox: 'Drafts', requireFlag: 'archived' });
    expect(listed.filter(row => row.uid === location.uid)).toHaveLength(1);
    expect(listed.find(row => row.uid === location.uid).flags).toContain('draft');
    await backend.invoke('maildir_store', { accountId: account.id, mailbox: 'Drafts', uid: 900002, rawSourceBase64: raw, flags: ['draft', 'seen'] });
    expect((await backend.invoke('maildir_list', { accountId: account.id, mailbox: 'Drafts', requireFlag: 'archived' })).find(row => row.uid === 900002)).toBeUndefined();
    expect((await backend.invoke('maildir_list', { accountId: account.id, mailbox: 'Drafts', requireFlag: null })).find(row => row.uid === 900002).flags).toEqual(['draft', 'seen']);
  });

  it('preserves outgoing identity, rich content, and attachment through sending', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const email = {
      to: 'nell@smokehouse.design', cc: 'ana@sizzlemedia.co', subject: 'Browser send',
      text: 'The final artwork', html: '<p>The <strong>final</strong> artwork</p>',
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: btoa('Fictional notes') }],
    };
    const built = await backend.invoke('smtp_build_mime', { account, email });
    const events = [];
    backend.on('send-server-append-complete', ({ payload }) => events.push(payload));
    await backend.invoke('smtp_send_email', { account, email, sentMailbox: 'Sent' });
    const sent = (await backend.invoke('imap_get_emails', { account, mailbox: 'Sent' })).emails.find(row => row.subject === email.subject);
    const full = (await backend.invoke('imap_get_email', { account, mailbox: 'Sent', uid: sent.uid })).email;
    expect(full.messageId).toBe(built.messageId);
    expect(full.html).toBe(email.html);
    expect(full.attachments).toHaveLength(1);
    expect(full.cc).toContainEqual(expect.objectContaining({ address: 'ana@sizzlemedia.co' }));
    expect(events).toContainEqual(expect.objectContaining({ ok: true, messageIdHeader: built.messageId }));
  });

  it('moves the server copy while keeping the original vault copy, then supports Undo', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const original = backend.snapshot().messages.find(row => row.accountId === account.id && row.mailbox === 'INBOX' && row.serverPresent && row.vaultPresent);
    const result = await backend.invoke('imap_move_emails', { account, sourceMailbox: 'INBOX', targetMailbox: 'Archive', uids: [original.uid] });
    expect(result.newUids).toHaveLength(1);
    expect(await backend.invoke('maildir_exists', { accountId: account.id, mailbox: 'INBOX', uid: original.uid })).toBe(true);
    const moved = (await backend.invoke('imap_get_emails', { account, mailbox: 'Archive' })).emails.find(row => row.uid === result.newUids[0]);
    expect(moved.messageId).toBe(original.messageId);
    expect(moved._mailbox).toBe('Archive');
    await backend.invoke('imap_move_emails', { account, sourceMailbox: 'Archive', targetMailbox: 'INBOX', uids: result.newUids });
    const inbox = (await backend.invoke('imap_get_emails', { account, mailbox: 'INBOX' })).emails;
    expect(inbox.filter(row => row.messageId === original.messageId)).toHaveLength(1);
  });

  it('moves recoverably deleted mail into Trash without removing its vault copy', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const original = backend.snapshot().messages.find(row => row.accountId === account.id && row.mailbox === 'INBOX' && row.vaultPresent && row.serverPresent);
    await backend.invoke('imap_delete_email', { account, mailbox: 'INBOX', uid: original.uid, permanent: false });
    const trash = (await backend.invoke('imap_get_emails', { account, mailbox: 'Trash' })).emails;
    expect(trash.some(row => row.messageId === original.messageId)).toBe(true);
    expect(await backend.invoke('maildir_exists', { accountId: account.id, mailbox: 'INBOX', uid: original.uid })).toBe(true);
  });

  it('keeps folder creation scoped to one account and reset restores the folder tree', async () => {
    const backend = createDemoBackend();
    const [account, other] = backend.accounts;
    await backend.invoke('imap_create_mailbox', { account, path: 'Clients/Demo review' });
    expect((await backend.invoke('imap_get_mailboxes', { account })).mailboxes.some(row => row.path === 'Clients/Demo review')).toBe(true);
    expect((await backend.invoke('imap_get_mailboxes', { account: other })).mailboxes.some(row => row.path === 'Clients/Demo review')).toBe(false);
    backend.reset();
    expect((await backend.invoke('imap_get_mailboxes', { account })).mailboxes.some(row => row.path === 'Clients/Demo review')).toBe(false);
  });

  it('copies selected mapped messages into the destination account during migration', async () => {
    const backend = createDemoBackend();
    const [source, destination] = backend.accounts;
    const before = (await backend.invoke('imap_get_emails', { account: destination, mailbox: 'Imported' })).emails;
    expect(before).toHaveLength(0);
    const result = await backend.invoke('start_migration', {
      sourceAccount: JSON.stringify(source), destAccount: JSON.stringify(destination),
      folderMappings: [{ source_path: 'INBOX', dest_path: 'Imported' }], includeLocalArchive: false,
    });
    expect(result).toMatchObject({ status: 'completed', migrated_emails: expect.any(Number) });
    expect(result.folders[0]).toMatchObject({ source_path: 'INBOX', dest_path: 'Imported', status: 'completed' });
    expect((await backend.invoke('imap_get_emails', { account: destination, mailbox: 'Imported' })).emails.length).toBe(result.migrated_emails);
  });

  it('restores selected local-only messages to the simulated server', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    expect(backend.snapshot().messages.find(row => row.uid === 207).serverPresent).toBe(false);
    const expectedRestoreCount = backend.snapshot().messages.filter(row => row.accountId === account.id && row.mailbox === 'INBOX' && row.vaultPresent && !row.serverPresent).length;
    const result = await backend.invoke('start_restore', { account: JSON.stringify(account), accountId: account.id, folders: ['INBOX'] });
    expect(result).toMatchObject({ status: 'completed', restored: expectedRestoreCount, uploaded_emails: expectedRestoreCount });
    expect(backend.snapshot().messages.find(row => row.uid === 207)).toMatchObject({ serverPresent: true, vaultPresent: true });
  });

  it('keeps vault marker flags separate from IMAP flags and index metadata', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const raw = btoa('From: rowan@primecut.studio\nSubject: Marker test\n\nA sample');
    await backend.invoke('maildir_store', { accountId: account.id, mailbox: 'Drafts', uid: 900003, rawSourceBase64: raw, flags: ['draft', 'seen'] });
    expect((await backend.invoke('maildir_list', { accountId: account.id, mailbox: 'Drafts', requireFlag: 'archived' })).some(row => row.uid === 900003)).toBe(false);
    await backend.invoke('local_index_append', { accountId: account.id, mailbox: 'Drafts', entries: [{ uid: 900003, flags: ['draft', 'seen'], source: 'local' }] });
    expect(await backend.invoke('maildir_exists', { accountId: account.id, mailbox: 'Drafts', uid: 900003 })).toBe(true);
    expect((await backend.invoke('maildir_list', { accountId: account.id, mailbox: 'Drafts', requireFlag: null })).find(row => row.uid === 900003).flags).toEqual(['draft', 'seen']);
  });

  it('deleting the last Time Capsule leaves an empty list', async () => {
    const backend = createDemoBackend();
    const accountId = backend.accounts[0].id;
    const rpc = (method, params = {}) => backend.invoke('daemon_rpc', { method, params: { accountId, ...params } });
    await rpc('snapshot.create_from_maildir');
    for (const item of await rpc('snapshot.list')) await rpc('snapshot.delete', { filename: item.filename });
    expect(await rpc('snapshot.list')).toEqual([]);
  });
});
