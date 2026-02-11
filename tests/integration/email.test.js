import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
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
const SMTP_HOST = env.SMTP_HOST;
const SMTP_PORT = Number(env.SMTP_PORT) || 587;

const account = {
  email: TEST_EMAIL,
  password: TEST_PASSWORD,
  imapHost: IMAP_HOST,
  imapPort: IMAP_PORT,
  smtpHost: SMTP_HOST,
  smtpPort: SMTP_PORT,
};

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

describe('Email Integration Tests', () => {
  let client;
  const testSubject = `Integration Test ${Date.now()}`;
  let sentEmailUid;

  beforeAll(() => {
    if (!TEST_EMAIL || !TEST_PASSWORD || TEST_EMAIL === 'your-email@example.com') {
      throw new Error(
        'Missing test credentials. Fill in .env.test with real email/password before running tests.'
      );
    }
  });

  afterAll(async () => {
    // Clean up: delete the test email if we found it
    if (sentEmailUid) {
      const cleanup = createImapClient();
      try {
        await cleanup.connect();
        const lock = await cleanup.getMailboxLock('INBOX');
        try {
          await cleanup.messageDelete(sentEmailUid, { uid: true });
        } finally {
          lock.release();
        }
        await cleanup.logout();
      } catch {
        // best-effort cleanup
      }
    }
  });

  // 1. IMAP Connection
  it('should connect and disconnect via IMAP', async () => {
    client = createImapClient();
    await client.connect();
    expect(client.usable).toBe(true);
    await client.logout();
  });

  // 2. List Mailboxes
  it('should list mailboxes and find INBOX', async () => {
    client = createImapClient();
    await client.connect();
    try {
      const mailboxes = await client.list();
      expect(mailboxes).toBeDefined();
      expect(Array.isArray(mailboxes)).toBe(true);
      expect(mailboxes.length).toBeGreaterThan(0);

      const inbox = mailboxes.find(
        (m) => m.path === 'INBOX' || m.specialUse === '\\Inbox'
      );
      expect(inbox).toBeDefined();
      expect(inbox.path).toBe('INBOX');
    } finally {
      await client.logout();
    }
  });

  // 3. Fetch Emails
  it('should fetch emails from INBOX', async () => {
    client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      expect(total).toBeGreaterThan(0);

      const end = total;
      const start = Math.max(1, total - 9); // fetch up to 10
      const emails = [];

      for await (const message of client.fetch(`${start}:${end}`, {
        envelope: true,
        flags: true,
        uid: true,
      })) {
        emails.push(message);
      }

      expect(emails.length).toBeGreaterThan(0);
      expect(emails[0].envelope).toBeDefined();
      expect(emails[0].envelope.subject).toBeDefined();
      expect(emails[0].uid).toBeDefined();
      expect(emails[0].flags).toBeDefined();
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // 4. Fetch Single Email
  it('should fetch and parse a full email', async () => {
    client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      expect(total).toBeGreaterThan(0);

      // Fetch the most recent email's UID
      let latestUid;
      for await (const message of client.fetch(`${total}:${total}`, {
        uid: true,
      })) {
        latestUid = message.uid;
      }
      expect(latestUid).toBeDefined();

      // Fetch full source by UID
      const message = await client.fetchOne(
        latestUid,
        { source: true, envelope: true, flags: true },
        { uid: true }
      );
      expect(message).toBeDefined();
      expect(message.source).toBeDefined();

      const parsed = await simpleParser(message.source);
      expect(parsed).toBeDefined();
      // At least one of text or html should be present
      expect(parsed.text || parsed.html).toBeTruthy();
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // 5. SMTP Verify
  it('should verify SMTP connection', async () => {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: TEST_EMAIL, pass: TEST_PASSWORD },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
    });

    const verified = await transporter.verify();
    expect(verified).toBe(true);
  });

  // 6. Send Email
  it('should send a test email to self', async () => {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: TEST_EMAIL, pass: TEST_PASSWORD },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
    });

    const result = await transporter.sendMail({
      from: TEST_EMAIL,
      to: TEST_EMAIL,
      subject: testSubject,
      text: `This is an automated integration test email sent at ${new Date().toISOString()}.`,
    });

    expect(result).toBeDefined();
    expect(result.messageId).toBeDefined();
    expect(result.accepted).toContain(TEST_EMAIL);
  });

  // 7. Search Emails
  it('should search for the test email', async () => {
    // Wait for delivery
    await new Promise((r) => setTimeout(r, 5000));

    client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ subject: testSubject }, { uid: true });
      expect(uids).toBeDefined();
      expect(uids.length).toBeGreaterThan(0);

      sentEmailUid = uids[uids.length - 1]; // save for cleanup & flag test
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // 8. Flag Email
  it('should flag an email as read then unread', async () => {
    expect(sentEmailUid).toBeDefined();

    client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Mark as read
      await client.messageFlagsAdd(sentEmailUid, ['\\Seen'], { uid: true });

      // Verify flag was set
      const afterAdd = await client.fetchOne(
        sentEmailUid,
        { flags: true },
        { uid: true }
      );
      expect(Array.from(afterAdd.flags)).toContain('\\Seen');

      // Mark as unread
      await client.messageFlagsRemove(sentEmailUid, ['\\Seen'], { uid: true });

      // Verify flag was removed
      const afterRemove = await client.fetchOne(
        sentEmailUid,
        { flags: true },
        { uid: true }
      );
      expect(Array.from(afterRemove.flags)).not.toContain('\\Seen');
    } finally {
      lock.release();
      await client.logout();
    }
  });
});
