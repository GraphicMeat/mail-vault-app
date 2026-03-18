import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.test
const envPath = resolve(import.meta.dirname, '../../.env.test');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return [key.trim(), rest.join('=').trim()];
    })
);

const TEST_EMAIL = env.TEST_EMAIL;
const TEST_PASSWORD = env.TEST_PASSWORD;
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;

function createImapClient() {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: TEST_EMAIL, pass: TEST_PASSWORD },
    logger: false,
    connectTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
}

function buildTestEml(subject) {
  return [
    `From: test@example.com`,
    `To: ${TEST_EMAIL}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test>`,
    '',
    'Test body for backup runner integration test.',
  ].join('\r\n');
}

describe('Backup Runner Integration Tests', { timeout: 30000 }, () => {
  let client;

  beforeAll(async () => {
    if (!TEST_EMAIL || !TEST_PASSWORD || TEST_EMAIL === 'your-email@example.com') {
      throw new Error(
        'Missing test credentials. Fill in .env.test with real email/password before running tests.'
      );
    }
    client = createImapClient();
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
    const deltaClient = createImapClient();
    await deltaClient.connect();

    try {
      await deltaClient.mailboxCreate(folder);

      // Append an initial email
      await deltaClient.append(folder, buildTestEml(`Delta-Initial ${Date.now()}`), []);

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
      await deltaClient.append(folder, buildTestEml(`Delta-New ${Date.now()}`), []);

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
