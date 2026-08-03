import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { simpleParser } from 'mailparser';
import { startSeededServer, createClient, deliver } from './mockHarness.js';

describe('Email Integration Tests', () => {
  let server;
  let client;
  const testSubject = `Integration Test ${Date.now()}`;
  let sentEmailUid;

  beforeAll(async () => {
    server = await startSeededServer();
  });

  afterAll(async () => {
    server?.stop();
  });

  // 1. IMAP Connection
  it('should connect and disconnect via IMAP', async () => {
    client = createClient(server);
    await client.connect();
    expect(client.usable).toBe(true);
    await client.logout();
  });

  // 2. List Mailboxes
  it('should list mailboxes and find INBOX', async () => {
    client = createClient(server);
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
    client = createClient(server);
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
    client = createClient(server);
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

  // 5. Deliver + search (was: SMTP verify + send-to-self + polling search)
  it('should deliver a test email and find it via SEARCH', async () => {
    sentEmailUid = await deliver(server, {
      subject: testSubject,
      text: `This is an automated integration test email sent at ${new Date().toISOString()}.`,
    });
    expect(sentEmailUid).toBeGreaterThan(0);

    client = createClient(server);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ subject: testSubject }, { uid: true });
      expect(uids.length).toBeGreaterThan(0);
      expect(uids).toContain(sentEmailUid);
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // 6. Flag Email
  it('should flag an email as read then unread', async () => {
    expect(sentEmailUid).toBeDefined();

    client = createClient(server);
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
