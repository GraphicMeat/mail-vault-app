import { describe, it, expect, beforeAll } from 'vitest';
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
    `Message-ID: <test-${Date.now()}-${Math.random().toString(36).slice(2)}@test>`,
    '',
    'Test body for integration test.',
  ].join('\r\n');
}

describe('IMAP Operations Integration Tests', { timeout: 30000 }, () => {
  beforeAll(() => {
    if (!TEST_EMAIL || !TEST_PASSWORD || TEST_EMAIL === 'your-email@example.com') {
      throw new Error(
        'Missing test credentials. Fill in .env.test with real email/password before running tests.'
      );
    }
  });

  it('should CREATE a mailbox folder', async () => {
    const folder = `TestOps-Create-${Date.now()}`;
    const client = createImapClient();
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      const mailboxes = await client.list();
      // Some servers prefix with INBOX. namespace (e.g. INBOX.TestOps-...)
      const found = mailboxes.find(
        (m) => m.path === folder || m.path === `INBOX.${folder}`
      );
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
    const client = createImapClient();
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      const emlContent = buildTestEml(subject);
      await client.append(folder, emlContent, ['\\Seen']);

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
    const client = createImapClient();
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      await client.append(folder, buildTestEml(subject), []);

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
    const client = createImapClient();
    await client.connect();
    try {
      await client.mailboxCreate(folder);

      // Append two test emails
      await client.append(folder, buildTestEml(`Expunge-A ${Date.now()}`), []);
      await client.append(folder, buildTestEml(`Expunge-B ${Date.now()}`), []);

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
    const client = createImapClient();
    await client.connect();
    try {
      await client.mailboxCreate(folder);
      await client.append(folder, buildTestEml(uniqueSubject), []);

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
