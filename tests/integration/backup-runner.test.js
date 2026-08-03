import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSeededServer, createClient, deliver } from './mockHarness.js';

describe('Backup Runner Integration Tests', { timeout: 30000 }, () => {
  let server;
  let client;

  beforeAll(async () => {
    server = await startSeededServer();
    client = createClient(server);
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.logout();
      } catch {
        // best-effort
      }
    }
    server?.stop();
  });

  it('should fetch all UIDs from INBOX', async () => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ all: true }, { uid: true });
      expect(Array.isArray(uids)).toBe(true);
      expect(uids.length).toBeGreaterThan(0);
    } finally {
      lock.release();
    }
  });

  it('should fetch MIME content for a single email', async () => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ all: true }, { uid: true });
      expect(uids.length).toBeGreaterThan(0);

      const uid = uids[0];
      const download = await client.download(uid, undefined, { uid: true });
      expect(download).toBeDefined();
      expect(download.content).toBeDefined();

      // Read stream into string
      const chunks = [];
      for await (const chunk of download.content) {
        chunks.push(chunk);
      }
      const mimeContent = Buffer.concat(chunks).toString('utf-8');
      expect(mimeContent.length).toBeGreaterThan(0);
      // MIME content should contain standard email headers
      expect(mimeContent).toMatch(/(?:From:|Subject:|Date:|MIME-Version:)/i);
    } finally {
      lock.release();
    }
  });

  it('should perform incremental UID delta (simulated)', async () => {
    const folder = `TestBackup-Delta-${Date.now()}`;

    // Use a separate client for folder operations to avoid lock conflicts
    const deltaClient = createClient(server);
    await deltaClient.connect();

    try {
      await deltaClient.mailboxCreate(folder);

      // Append an initial email
      await deliver(server, { subject: `Delta-Initial ${Date.now()}`, mailbox: folder });

      // Get initial UID count
      let lock = await deltaClient.getMailboxLock(folder);
      let initialUids;
      try {
        initialUids = await deltaClient.search({ all: true }, { uid: true });
      } finally {
        lock.release();
      }
      const initialCount = initialUids.length;
      expect(initialCount).toBe(1);

      // Append a new email (simulates new mail arriving)
      await deliver(server, { subject: `Delta-New ${Date.now()}`, mailbox: folder });

      // Fetch UIDs again -- count should increase by 1
      lock = await deltaClient.getMailboxLock(folder);
      let afterAppendUids;
      try {
        afterAppendUids = await deltaClient.search({ all: true }, { uid: true });
      } finally {
        lock.release();
      }
      expect(afterAppendUids.length).toBe(initialCount + 1);

      // Delete the appended email
      lock = await deltaClient.getMailboxLock(folder);
      try {
        const newUid = afterAppendUids[afterAppendUids.length - 1];
        await deltaClient.messageDelete(newUid, { uid: true });
      } finally {
        lock.release();
      }

      // Fetch UIDs again -- count should return to original
      lock = await deltaClient.getMailboxLock(folder);
      let afterDeleteUids;
      try {
        afterDeleteUids = await deltaClient.search({ all: true }, { uid: true });
      } finally {
        lock.release();
      }
      expect(afterDeleteUids.length).toBe(initialCount);
    } finally {
      try {
        await deltaClient.mailboxDelete(folder);
      } catch {
        // best-effort cleanup
      }
      await deltaClient.logout();
    }
  });
});
