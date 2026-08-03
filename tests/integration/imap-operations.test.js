import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSeededServer, createClient, deliver } from './mockHarness.js';

describe('IMAP Operations Integration Tests', { timeout: 30000 }, () => {
  let server;

  beforeAll(async () => {
    server = await startSeededServer();
  });

  afterAll(async () => {
    server?.stop();
  });

  it('should CREATE a mailbox folder', async () => {
    const folder = `TestOps-Create-${Date.now()}`;
    const client = createClient(server);
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      const mailboxes = await client.list();
      const found = mailboxes.find((m) => m.path === folder);
      expect(found).toBeDefined();
    } finally {
      try {
        await client.mailboxDelete(folder);
      } catch {
        // best-effort cleanup
      }
      await client.logout();
    }
  });

  it('should APPEND an email to a folder', async () => {
    const folder = `TestOps-Append-${Date.now()}`;
    const subject = `APPEND Test ${Date.now()}`;
    const client = createClient(server);
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      await deliver(server, { subject, mailbox: folder });

      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ subject }, { uid: true });
        expect(uids.length).toBeGreaterThan(0);
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.mailboxDelete(folder);
      } catch {
        // best-effort
      }
      await client.logout();
    }
  });

  it('should set and clear flags on a message', async () => {
    const folder = `TestOps-Flags-${Date.now()}`;
    const subject = `Flag Test ${Date.now()}`;
    const client = createClient(server);
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      await deliver(server, { subject, mailbox: folder });

      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ all: true }, { uid: true });
        expect(uids.length).toBe(1);
        const uid = uids[0];

        // Set \\Flagged
        await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
        const afterAdd = await client.fetchOne(uid, { flags: true }, { uid: true });
        expect(Array.from(afterAdd.flags)).toContain('\\Flagged');

        // Clear \\Flagged
        await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
        const afterRemove = await client.fetchOne(uid, { flags: true }, { uid: true });
        expect(Array.from(afterRemove.flags)).not.toContain('\\Flagged');
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.mailboxDelete(folder);
      } catch {
        // best-effort
      }
      await client.logout();
    }
  });

  it('should UID EXPUNGE a message (permanent delete)', async () => {
    const folder = `TestOps-Expunge-${Date.now()}`;
    const client = createClient(server);
    await client.connect();
    try {
      await client.mailboxCreate(folder);

      // Append two test emails
      await deliver(server, { subject: `Expunge-A ${Date.now()}`, mailbox: folder });
      await deliver(server, { subject: `Expunge-B ${Date.now()}`, mailbox: folder });

      const lock = await client.getMailboxLock(folder);
      try {
        const allUids = await client.search({ all: true }, { uid: true });
        expect(allUids.length).toBe(2);

        const [uidA, uidB] = allUids;

        // Delete only email-A by UID
        await client.messageDelete(uidA, { uid: true });

        // Verify only uidB remains
        const remaining = await client.search({ all: true }, { uid: true });
        expect(remaining).not.toContain(uidA);
        expect(remaining).toContain(uidB);
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.mailboxDelete(folder);
      } catch {
        // best-effort
      }
      await client.logout();
    }
  });

  it('should SEARCH emails by subject', async () => {
    const folder = `TestOps-Search-${Date.now()}`;
    const uniqueSubject = `SearchTarget ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const client = createClient(server);
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      await deliver(server, { subject: uniqueSubject, mailbox: folder });

      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ subject: uniqueSubject }, { uid: true });
        expect(uids.length).toBeGreaterThanOrEqual(1);
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.mailboxDelete(folder);
      } catch {
        // best-effort
      }
      await client.logout();
    }
  });
});
