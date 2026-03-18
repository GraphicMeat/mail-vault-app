import { describe, it, expect, afterAll } from 'vitest';
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
const TEST_EMAIL2 = env.TEST_EMAIL2;
const TEST_PASSWORD2 = env.TEST_PASSWORD2;
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;

function createImapClient(email, password) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    connectTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
}

const hasBothAccounts = !!(TEST_EMAIL2 && TEST_PASSWORD2);

describe.skipIf(!hasBothAccounts)(
  'Migration Runner Integration Tests',
  { timeout: 30000 },
  () => {
    let client1;
    let client2;
    const testFolder = `MigrTest-${Date.now()}`;
    let copiedMessageId;

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
    });

    it('should connect to both test accounts', async () => {
      client1 = createImapClient(TEST_EMAIL, TEST_PASSWORD);
      client2 = createImapClient(TEST_EMAIL2, TEST_PASSWORD2);

      await client1.connect();
      expect(client1.usable).toBe(true);

      await client2.connect();
      expect(client2.usable).toBe(true);
    });

    it('should create a folder on destination', async () => {
      await client2.mailboxCreate(testFolder);

      const mailboxes = await client2.list();
      // Hostinger prefixes with INBOX. namespace
      const found = mailboxes.find(
        (m) => m.path === testFolder || m.path === `INBOX.${testFolder}`
      );
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
  }
);
