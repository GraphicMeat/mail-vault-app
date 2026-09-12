import { describe, expect, it } from 'vitest';
import { createDemoBackend } from '../backend.js';

describe('demo mailbox backend', () => {
  it('seeds three fictional accounts with nested mailboxes and mixed custody', () => {
    const backend = createDemoBackend();
    const state = backend.snapshot();

    expect(state.accounts).toHaveLength(3);
    expect(state.accounts.map(account => account.email)).toEqual([
      'rowan@primecut.studio',
      'rowan.marsh@gmail.com',
      'accounts@primecut.studio',
    ]);
    expect(state.mailboxes.some(mailbox => mailbox.path === 'Clients')).toBe(true);
    expect(state.messages.some(message => message.custody === 'server')).toBe(true);
    expect(state.messages.some(message => message.custody === 'both')).toBe(true);
    expect(state.messages.some(message => message.custody === 'local-only')).toBe(true);
    expect(state.messages).toHaveLength(300);
    state.accounts.forEach(account => {
      const accountMessages = state.messages.filter(message => message.accountId === account.id);
      expect(accountMessages).toHaveLength(100);
      expect(new Set(accountMessages.map(message => new Date(message.date).getUTCMonth())).size).toBe(12);
      expect(new Set(accountMessages.map(message => new Date(message.date).getUTCFullYear())).size).toBeGreaterThanOrEqual(4);
      expect(accountMessages.every(message => message.serverPresent || message.vaultPresent)).toBe(true);
    });
    expect(state.messages.filter(message => message.accountId === state.accounts[0].id && message.mailbox === 'INBOX').length).toBeGreaterThanOrEqual(70);
    expect(new Set(state.messages.map(message => message.messageId)).size).toBe(state.messages.length);
    const primaryMonths = new Set(state.messages.filter(message => message.accountId === state.accounts[0].id && message.mailbox === 'INBOX').map(message => new Date(message.date).getUTCMonth()));
    const years = new Set(state.messages.map(message => new Date(message.date).getUTCFullYear()));
    expect(primaryMonths.size).toBe(12);
    expect(years.size).toBeGreaterThanOrEqual(4);
    expect(state.messages.every(message => new Date(message.date).getTime() <= Date.now())).toBe(true);
  });

  it('seeds readable long threads and self-contained multipart newsletters', async () => {
    const backend = createDemoBackend();
    const state = backend.snapshot();
    const threadRows = state.messages.filter(message => message.threadId === 'brand-refresh');
    expect(threadRows).toHaveLength(10);
    expect(threadRows.filter(message => message.mailbox === 'INBOX')).toHaveLength(5);
    expect(threadRows.slice(1).every((message, index) => message.inReplyTo === threadRows[index].messageId)).toBe(true);
    expect(threadRows.slice(1).every((message) => message.references.length >= 1)).toBe(true);
    expect(threadRows[9].references).toHaveLength(9);

    const newsletters = state.messages.filter(message => message.from?.address?.endsWith('@newsletter.example'));
    expect(newsletters).toHaveLength(12);
    expect(newsletters.every(message => message.rawSource.includes('multipart/alternative') && message.rawSource.includes('<h1'))).toBe(true);
    expect(new Set(newsletters.map(message => backend.snapshot().messages.find(row => row.messageId === message.messageId)?.html)).size).toBe(12);
    const classifications = await backend.invoke('daemon_rpc', { method: 'classification.results', params: { accountId: state.accounts[0].id } });
    expect(classifications).toEqual(expect.arrayContaining([expect.objectContaining({ classification: expect.objectContaining({ category: 'newsletter' }) })]));
  });

  it('round-trips an HTML newsletter through the simulated vault', async () => {
    const backend = createDemoBackend();
    const newsletter = backend.snapshot().messages.find(message => message.from?.address?.endsWith('@newsletter.example'));
    await backend.invoke('maildir_store', { accountId: newsletter.accountId, mailbox: 'Archive', uid: 990001, rawSourceBase64: newsletter.rawSourceBase64, flags: ['archived'] });
    const stored = await backend.invoke('maildir_read', { accountId: newsletter.accountId, mailbox: 'Archive', uid: 990001 });
    expect(stored.text).toContain(newsletter.text.split('\n')[0]);
    expect(stored.html).toContain('<h1');
  });

  it('keeps long-thread attachment bytes through a vault round trip', async () => {
    const backend = createDemoBackend();
    const source = backend.snapshot().messages.find(message => message.threadId === 'brand-refresh' && message.attachments.length);
    await backend.invoke('maildir_store', { accountId: source.accountId, mailbox: 'Archive', uid: 990002, rawSourceBase64: source.rawSourceBase64, flags: ['archived'] });
    const stored = await backend.invoke('maildir_read_attachment', { accountId: source.accountId, mailbox: 'Archive', uid: 990002, attachmentIndex: 0 });
    expect(typeof stored).toBe('string');
    expect(stored.length).toBeGreaterThan(50);
  });

  it('archives a server message and then removes only the server copy', async () => {
    const backend = createDemoBackend();
    const target = backend.snapshot().messages.find(message => message.custody === 'server');

    await backend.invoke('maildir_store', {
      accountId: target.accountId,
      mailbox: target.mailbox,
      uid: target.uid,
      rawSourceBase64: target.rawSourceBase64,
      flags: ['archived'],
    });
    await expect(backend.invoke('maildir_exists', {
      accountId: target.accountId,
      mailbox: target.mailbox,
      uid: target.uid,
    })).resolves.toBe(true);

    await backend.invoke('imap_delete_email', {
      account: target.account,
      mailbox: target.mailbox,
      uid: target.uid,
      permanent: true,
    });

    const after = backend.snapshot().messages.find(message => message.id === target.id);
    expect(after.custody).toBe('local-only');
    expect(after.serverPresent).toBe(false);
    expect(after.vaultPresent).toBe(true);
  });

  it('sends a message into the simulated outbox and Sent mailbox', async () => {
    const backend = createDemoBackend();
    const account = backend.snapshot().accounts[0];
    const result = await backend.invoke('smtp_send_email', {
      account,
      email: { to: 'nell@smokehouse.design', subject: 'A demo reply', text: 'Thanks!' },
      sentMailbox: 'Sent',
    });

    expect(result).toMatchObject({ success: true, simulated: true });
    expect(backend.snapshot().messages.some(message => message.subject === 'A demo reply' && message.mailbox === 'Sent')).toBe(true);
    const sent = backend.snapshot().messages.find(message => message.subject === 'A demo reply');
    expect(sent.to).toEqual([{ name: '', address: 'nell@smokehouse.design' }]);
    expect(new Date(sent.date).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('searches server-only mail and returns simulated transfer and classification data', async () => {
    const backend = createDemoBackend();
    const account = backend.snapshot().accounts[0];
    await expect(backend.invoke('imap_search_emails', { account, mailbox: 'INBOX', query: 'workspace' })).resolves.toMatchObject({ total: 1 });
    await expect(backend.invoke('get_transfer_stats')).resolves.toMatchObject({ accounts: expect.any(Object) });
    await expect(backend.invoke('daemon_rpc', { method: 'classification.summary', params: { accountId: account.id } })).resolves.toMatchObject({ total: expect.any(Number), by_category: expect.any(Object) });
  });

  it('keeps cleanup, backup and learning state meaningful after a user change', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const results = await backend.invoke('daemon_rpc', { method: 'classification.results', params: { accountId: account.id } });
    expect(results[0]).toMatchObject({ from: expect.any(String), classification: { confidence: expect.any(Number) } });
    await backend.invoke('daemon_rpc', { method: 'classification.override', params: { accountId: account.id, messageId: results[0].messageId, category: 'personal', action: 'review' } });
    expect((await backend.invoke('daemon_rpc', { method: 'classification.results', params: { accountId: account.id } })).find(row => row.messageId === results[0].messageId).classification).toMatchObject({ category: 'personal', action: 'review' });
    const backup = await backend.invoke('backup_status', { accountId: account.id });
    expect(backup).toMatchObject({ folders: expect.any(Array), total_server: expect.any(Number), total_app: expect.any(Number), external_available: false });
    const stats = await backend.invoke('get_transfer_stats', { accountId: account.id });
    expect(Object.keys(stats.accounts[account.id].days)).toHaveLength(7);
  });

  it('persists staged local drafts, keeps immutable capsules, and updates moved mailbox identity', async () => {
    const backend = createDemoBackend();
    const account = backend.snapshot().accounts[0];
    const raw = btoa('From: rowan@primecut.studio\nTo: nell@smokehouse.design\nSubject: Staged draft\n\nA browser-only draft');
    await backend.invoke('maildir_store', { accountId: account.id, mailbox: 'Drafts', uid: 900001, rawSourceBase64: raw, flags: ['draft', 'seen'] });
    expect(backend.snapshot().messages.some(message => message.uid === 900001 && message.vaultPresent)).toBe(true);
    await backend.invoke('imap_move_emails', { accountId: account.id, sourceMailbox: 'Drafts', targetMailbox: 'Archive', uids: [900001] });
    expect(backend.snapshot().messages.find(message => message.uid === 900001)).toMatchObject({ mailbox: 'Archive', _mailbox: 'Archive' });
    const listed = await backend.invoke('daemon_rpc', { method: 'snapshot.list', params: { accountId: account.id } });
    const filename = listed[0].filename;
    const before = await backend.invoke('daemon_rpc', { method: 'snapshot.load', params: { accountId: account.id, filename } });
    await backend.invoke('maildir_delete', { accountId: account.id, mailbox: 'Archive', uid: 900001 });
    const after = await backend.invoke('daemon_rpc', { method: 'snapshot.load', params: { accountId: account.id, filename } });
    expect(after).toEqual(before);
  });

  it('reset returns a fresh isolated state and never reports unsupported external work as success', async () => {
    const backend = createDemoBackend();
    const baseline = backend.snapshot();
    await backend.invoke('imap_delete_email', {
      account: baseline.accounts[0], mailbox: 'INBOX', uid: baseline.messages[0].uid, permanent: true,
    });

    await expect(backend.invoke('oauth2_auth_url', { email: 'visitor@example.com', provider: 'google' }))
      .rejects.toMatchObject({ code: 'DEMO_UNSUPPORTED' });
    backend.reset();
    expect(backend.snapshot().messages).toEqual(baseline.messages);
  });

  it('keeps native-shaped sync, folder, backup and browser file contracts usable', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const started = await backend.invoke('daemon_rpc', { method: 'sync.now', params: { account, mailbox: 'Sent' } });
    expect(started).toMatchObject({ started: true, account_id: account.id, mailbox: 'Sent' });
    expect(Number.isFinite(started.ticket)).toBe(true);
    await expect(backend.invoke('daemon_rpc', { method: 'sync.wait', params: { ticket: started.ticket } }))
      .resolves.toMatchObject({ account_id: account.id, mailbox: 'Sent', success: true, total_emails: expect.any(Number) });

    const mailboxes = (await backend.invoke('imap_get_mailboxes', { account })).mailboxes;
    expect(mailboxes.map(folder => folder.path)).toEqual(expect.arrayContaining(['Clients', 'Clients/Skewer', 'Clients/Tenderloin']));
    const backup = await backend.invoke('backup_status', { accountId: account.id });
    expect(backup.total_app).toBeLessThanOrEqual(backup.total_server);
    expect(Buffer.from(backend.snapshot().messages.find(row => row.uid === 201).attachments[0].contentBase64, 'base64').toString('ascii')).toContain('%PDF-1.4');
  });
});
