import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSeededServer, createClient } from './mockHarness.js';

describe('Migration Runner Integration Tests', { timeout: 30000 }, () => {
  let lukeServer;
  let vaderServer;
  let client1;
  let client2;
  const testFolder = `MigrTest-${Date.now()}`;
  let copiedMessageId;

  beforeAll(async () => {
    lukeServer = await startSeededServer({ owner: 'luke@example.test' });
    vaderServer = await startSeededServer({ owner: 'vader@example.test' });
  });

  afterAll(async () => {
    // Clean up test folder on destination
    if (client2) {
      try {
        await client2.mailboxDelete(testFolder);
      } catch {
        // best-effort
      }
      try {
        await client2.logout();
      } catch {
        // best-effort
      }
    }
    if (client1) {
      try {
        await client1.logout();
      } catch {
        // best-effort
      }
    }
    lukeServer?.stop();
    vaderServer?.stop();
  });

  it('should connect to both test accounts', async () => {
    client1 = createClient(lukeServer);
    client2 = createClient(vaderServer);

    await client1.connect();
    expect(client1.usable).toBe(true);

    await client2.connect();
    expect(client2.usable).toBe(true);
  });

  it('should create a folder on destination', async () => {
    await client2.mailboxCreate(testFolder);

    const mailboxes = await client2.list();
    const found = mailboxes.find((m) => m.path === testFolder);
    expect(found).toBeDefined();
  });

  it('should copy an email from source to destination', async () => {
    // Fetch one email's MIME from source INBOX
    const lock1 = await client1.getMailboxLock('INBOX');
    let mimeContent;
    try {
      const uids = await client1.search({ all: true }, { uid: true });
      expect(uids.length).toBeGreaterThan(0);

      const uid = uids[0];
      const download = await client1.download(uid, undefined, { uid: true });
      const chunks = [];
      for await (const chunk of download.content) {
        chunks.push(chunk);
      }
      mimeContent = Buffer.concat(chunks).toString('utf-8');

      // Extract Message-ID for dedup test
      const msgIdMatch = mimeContent.match(/^Message-ID:\s*(.+)$/im);
      if (msgIdMatch) {
        copiedMessageId = msgIdMatch[1].trim();
      }
    } finally {
      lock1.release();
    }

    expect(mimeContent).toBeDefined();
    expect(mimeContent.length).toBeGreaterThan(0);

    // APPEND to destination test folder
    await client2.append(testFolder, mimeContent, ['\\Seen']);

    // Verify it arrived
    const lock2 = await client2.getMailboxLock(testFolder);
    try {
      const destUids = await client2.search({ all: true }, { uid: true });
      expect(destUids.length).toBeGreaterThanOrEqual(1);
    } finally {
      lock2.release();
    }
  });

  it('should detect duplicate by Message-ID', async () => {
    // copiedMessageId was extracted in the previous test
    expect(copiedMessageId).toBeDefined();

    const lock = await client2.getMailboxLock(testFolder);
    try {
      // Search for the Message-ID in the test folder using header search
      const uids = await client2.search(
        { header: { 'Message-ID': copiedMessageId } },
        { uid: true }
      );
      // Should find exactly 1 match (the email we copied)
      expect(uids.length).toBe(1);
    } finally {
      lock.release();
    }
  });
});
