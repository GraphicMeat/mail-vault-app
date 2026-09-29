import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('answers the vault registry reads in the daemon shape: uid sets, and light rows without bodies', async () => {
    const backend = createDemoBackend();
    const target = backend.snapshot().messages.find(message => message.custody === 'server');
    await backend.invoke('maildir_store', { accountId: target.accountId, mailbox: target.mailbox, uid: target.uid, rawSourceBase64: target.rawSourceBase64, flags: ['archived'] });
    // The app's path: a DAEMON_OWNED name arrives as daemon_rpc.
    const sets = await backend.invoke('daemon_rpc', { method: 'vault_uid_sets', params: { accountId: target.accountId, mailbox: target.mailbox } });
    expect(sets.saved).toContain(target.uid);
    expect(sets.archived).toContain(target.uid);
    expect([...sets.saved].sort((a, b) => a - b)).toEqual(sets.saved);

    const rows = await backend.invoke('daemon_rpc', { method: 'vault_light_rows', params: { accountId: target.accountId, mailbox: target.mailbox, uids: [target.uid, 987654321] } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: target.uid, isArchived: true });
    expect(typeof rows[0].snippet).toBe('string');
    expect(rows[0]).not.toHaveProperty('text');
    expect(rows[0]).not.toHaveProperty('html');
    await backend.invoke('vault_apply_flags', { accountId: target.accountId, mailbox: target.mailbox, changes: [{ uid: target.uid, flags: ['\\Seen'] }] });
    const [seen] = await backend.invoke('vault_light_rows', { accountId: target.accountId, mailbox: target.mailbox, uids: [target.uid] });
    expect(seen.flags).toEqual(expect.arrayContaining(['seen', '\\Seen']));
    const all = await backend.invoke('vault_light_rows', { accountId: target.accountId, mailbox: target.mailbox });
    expect(all.map(row => row.uid)).toEqual(sets.saved);
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

  it('answers the MBOX import options: a probe, and label mode filing to the fallback folder', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const sourcePath = 'browser-sample/mailvault-demo.mbox';
    const probe = await backend.invoke('daemon_rpc', { method: 'mbox_probe', params: { sourcePath, accountId: account.id } });
    expect(probe).toMatchObject({ bytes: expect.any(Number), hasLabels: false, foldersKnown: true, sampledMessages: expect.any(Number) });

    const result = await backend.invoke('daemon_rpc', { method: 'import_mbox', params: {
      sourcePath, accountId: account.id, mode: 'local', mailbox: 'Archive', fallbackMailbox: 'Archive', useLabels: true,
    } });
    expect(result).toMatchObject({ emailCount: 1, skippedCount: 0, accountId: account.id, mailbox: 'Archive', folders: [{ mailbox: 'Archive', imported: 1, skipped: 0 }] });
    expect(backend.snapshot().messages.some(row => row.accountId === account.id && row.mailbox === 'Archive' && row.subject === 'Imported sample MBOX message')).toBe(true);
  });

  // Mode 1 is a daemon job that answers at once and reports by events; the
  // demo runs a short simulated one with the same routes, shapes and codes.
  describe('an MBOX upload to the server', () => {
    const sourcePath = 'browser-sample/mailvault-demo.mbox';
    let backend;
    let account;
    let events;
    const rpc = (method, params) => backend.invoke('daemon_rpc', { method, params });
    const last = () => events[events.length - 1];
    const run = () => vi.advanceTimersByTime(10_000);

    beforeEach(() => {
      vi.useFakeTimers();
      backend = createDemoBackend();
      account = backend.accounts[0];
      events = [];
      backend.on('mbox-import-progress', ({ payload }) => events.push(payload));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('starts at once, reports progress with the daemon\'s shape, and ends with a server copy in the target folder', async () => {
      const started = await rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'Clients', useLabels: false });
      expect(started).toEqual({ jobId: expect.stringMatching(/^[A-Za-z0-9-]{1,64}$/), started: true });
      expect(last()).toMatchObject({ mode: 'server', jobId: started.jobId, accountId: account.id, fileName: 'mailvault-demo.mbox', active: true, state: 'running' });
      const { jobs } = await rpc('mbox_upload_status', {});
      expect(jobs).toEqual([expect.objectContaining({ jobId: started.jobId, live: true, active: true, state: 'running' })]);

      run();
      const done = last();
      expect(done).toMatchObject({ mode: 'server', jobId: started.jobId, active: false, state: 'done', uploadedCount: 1, skippedCount: 0, failedCount: 0, foldersChanged: false, etaSeconds: null });
      expect(done.bytesDone).toBe(done.bytesTotal);
      // Every running event before it moved forward on bytes.
      const bytes = events.map(e => e.bytesDone);
      expect([...bytes].sort((a, b) => a - b)).toEqual(bytes);
      const row = backend.snapshot().messages.find(m => m.accountId === account.id && m.mailbox === 'Clients' && m.subject === 'Uploaded sample MBOX message');
      expect(row).toMatchObject({ custody: 'both' });
      await expect(rpc('mbox_upload_status', {})).resolves.toEqual({ jobs: [] });
    });

    it('pauses, resumes, and holds one upload per account', async () => {
      const { jobId } = await rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false });
      await expect(rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false }))
        .rejects.toThrow(new RegExp(`^E_MBOX_UPLOAD_RUNNING: ${jobId}$`));

      await expect(rpc('mbox_upload_pause', { jobId })).resolves.toEqual({ jobId, paused: true });
      expect(last()).toMatchObject({ jobId, active: true, state: 'paused', paused: true });
      const held = events.length;
      run();
      expect(events).toHaveLength(held);
      expect((await rpc('mbox_upload_status', {})).jobs[0]).toMatchObject({ state: 'paused', live: true });

      await expect(rpc('mbox_upload_resume', { jobId })).resolves.toEqual({ jobId, resumed: true, restarted: false });
      expect(last()).toMatchObject({ state: 'running', paused: false });
      run();
      expect(last()).toMatchObject({ active: false, state: 'done', uploadedCount: 1 });
    });

    it('a cancel keeps a journal to resume or discard, and a fresh start of that file is refused as resumable', async () => {
      const { jobId } = await rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false });
      await expect(rpc('mbox_upload_cancel', { jobId })).resolves.toEqual({ jobId, cancelled: true });
      expect(last()).toMatchObject({ jobId, active: false, state: 'cancelled' });
      expect((await rpc('mbox_upload_status', {})).jobs).toEqual([expect.objectContaining({ jobId, live: false, active: false, state: 'cancelled' })]);
      await expect(rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false }))
        .rejects.toThrow(new RegExp(`^E_MBOX_UPLOAD_RESUMABLE: ${jobId}$`));

      await expect(rpc('mbox_upload_discard', { jobId })).resolves.toEqual({ jobId, discarded: true });
      await expect(rpc('mbox_upload_status', {})).resolves.toEqual({ jobs: [] });
      for (const method of ['mbox_upload_pause', 'mbox_upload_resume', 'mbox_upload_cancel', 'mbox_upload_discard']) {
        await expect(rpc(method, { jobId })).rejects.toThrow(new RegExp(`^E_MBOX_UPLOAD_NOT_FOUND: ${jobId}$`));
      }
      // Nothing was uploaded by the cancelled run, and a new one starts.
      expect(backend.snapshot().messages.some(m => m.subject === 'Uploaded sample MBOX message')).toBe(false);
      await expect(rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false }))
        .resolves.toMatchObject({ started: true });
    });

    it('a cancelled upload resumes from its journal', async () => {
      const { jobId } = await rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false });
      await rpc('mbox_upload_cancel', { jobId });
      await expect(rpc('mbox_upload_resume', { jobId, sourcePath })).resolves.toEqual({ jobId, resumed: true, restarted: false });
      expect(last()).toMatchObject({ jobId, active: true, state: 'running' });
      run();
      expect(last()).toMatchObject({ jobId, active: false, state: 'done', uploadedCount: 1 });
    });

    it('reset forgets every upload and its timers', async () => {
      await rpc('import_mbox', { sourcePath, accountId: account.id, mode: 'server', mailbox: 'INBOX', useLabels: false });
      backend.reset();
      const before = events.length;
      run();
      expect(events).toHaveLength(before);
      await expect(rpc('mbox_upload_status', {})).resolves.toEqual({ jobs: [] });
    });
  });

  it('imports into a new folder kept on this computer, lists it and deletes it, as the daemon does', async () => {
    const backend = createDemoBackend();
    const account = backend.accounts[0];
    const rpc = (method, params) => backend.invoke('daemon_rpc', { method, params });
    await expect(rpc('list_local_folders', { accountId: account.id })).resolves.toEqual([]);

    const result = await rpc('import_mbox', { sourcePath: 'browser-sample/mailvault-demo.mbox', accountId: account.id, mode: 'folder' });
    const name = result.folder?.name;
    expect(name).toMatch(/^MBOX import \d{4}-\d{2}-\d{2}$/);
    expect(result).toMatchObject({ emailCount: 1, skippedCount: 0, accountId: account.id, mailbox: name, folder: { name, dir: name.replace(/ /g, '_') } });
    // A second import the same day gets the next name, as the daemon's does.
    const again = await rpc('import_mbox', { sourcePath: 'browser-sample/mailvault-demo.mbox', accountId: account.id, mode: 'folder' });
    expect(again.folder.name).toBe(`${name} 2`);

    const listed = await rpc('list_local_folders', { accountId: account.id });
    expect(listed.map(f => f.name)).toEqual([name, `${name} 2`]);
    expect(listed[0]).toMatchObject({ dir: name.replace(/ /g, '_'), kind: 'import' });
    // Its mail is in the vault only, and the server folder list never names it.
    const vault = await rpc('vault_uid_sets', { accountId: account.id, mailbox: name });
    expect(vault.archived).toHaveLength(1);
    const { mailboxes } = await backend.invoke('imap_get_mailboxes', { accountId: account.id });
    expect(mailboxes.some(m => m.path === name)).toBe(false);
    // Another account has none.
    await expect(rpc('list_local_folders', { accountId: backend.accounts[1].id })).resolves.toEqual([]);

    await expect(rpc('delete_local_folder', { accountId: account.id, name: 'INBOX' })).rejects.toThrow(/^E_NOT_LOCAL_FOLDER: /);
    await expect(rpc('delete_local_folder', { accountId: account.id, name })).resolves.toMatchObject({ deleted: 1 });
    expect((await rpc('list_local_folders', { accountId: account.id })).map(f => f.name)).toEqual([`${name} 2`]);
    expect((await rpc('vault_uid_sets', { accountId: account.id, mailbox: name })).saved).toEqual([]);
    // Survives a saved and restored demo session.
    const restored = createDemoBackend();
    restored.restoreState(backend.exportState());
    expect((await restored.invoke('daemon_rpc', { method: 'list_local_folders', params: { accountId: account.id } })).map(f => f.name)).toEqual([`${name} 2`]);
  });

  it('serves daemon-owned search index commands through daemon_rpc', async () => {
    const backend = createDemoBackend();
    const status = await backend.invoke('daemon_rpc', { method: 'search_index_status', params: {} });
    expect(status).toMatchObject({ available: false, state: 'unavailable', firstPassDone: false });
    await expect(backend.invoke('daemon_rpc', { method: 'search_index_destroy', params: {} })).resolves.toEqual({ ok: true });
    await expect(backend.invoke('daemon_rpc', { method: 'vault_search', params: { request: { accountId: 'x', query: 'y' } } })).resolves.toEqual({ available: false });
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
