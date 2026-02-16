import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeDisplayEmails } from '../../src/services/emailListUtils.js';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const envPath = resolve(import.meta.dirname, '../../.env.test');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [key, ...rest] = l.split('=');
      return [key.trim(), rest.join('=').trim()];
    })
);

const LUKE = { email: env.TEST_EMAIL, password: env.TEST_PASSWORD };
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;
const SMTP_HOST = env.SMTP_HOST;
const SMTP_PORT = Number(env.SMTP_PORT) || 587;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createImap(account) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    connectTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
}

function createSmtp(account) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: account.email, pass: account.password },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
  });
}

async function waitForDelivery(account, subject, maxWaitMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const client = createImap(account);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ subject }, { uid: true });
        if (uids.length > 0) return uids[uids.length - 1];
      } finally {
        lock.release();
      }
      await client.logout();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Email "${subject}" not delivered within ${maxWaitMs}ms`);
}

async function fetchHeaders(account) {
  const client = createImap(account);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const emails = [];
  try {
    for await (const msg of client.fetch('1:*', { envelope: true, uid: true })) {
      emails.push({
        uid: msg.uid,
        subject: msg.envelope.subject,
        date: msg.envelope.date?.toISOString() || '2026-01-01T00:00:00Z',
        from: { address: msg.envelope.from?.[0]?.address },
        flags: [],
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return emails;
}

async function deleteByUid(account, uid) {
  const client = createImap(account);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    await client.messageDelete(uid, { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
const RUN_ID = Date.now();
const cleanupUids = [];

describe('Local-Only Flag Detection (send → archive → delete → verify)', () => {
  const subjectA = `[LocalOnly-${RUN_ID}] Email A (will be deleted)`;
  const subjectB = `[LocalOnly-${RUN_ID}] Email B (stays on server)`;
  let uidA, uidB;

  beforeAll(() => {
    if (!LUKE.email || !LUKE.password) {
      throw new Error('Missing test credentials in .env.test');
    }
  });

  afterAll(async () => {
    // Best-effort cleanup of any remaining test emails
    for (const uid of cleanupUids) {
      try {
        await deleteByUid(LUKE, uid);
      } catch {
        // already deleted or doesn't exist
      }
    }
  });

  // Step 1: Send two test emails
  it('should send two test emails to Luke', async () => {
    const smtp = createSmtp(LUKE);
    const resultA = await smtp.sendMail({
      from: LUKE.email,
      to: LUKE.email,
      subject: subjectA,
      text: 'This email will be deleted from server but kept locally.',
    });
    expect(resultA.accepted).toContain(LUKE.email);

    const resultB = await smtp.sendMail({
      from: LUKE.email,
      to: LUKE.email,
      subject: subjectB,
      text: 'This email stays on the server.',
    });
    expect(resultB.accepted).toContain(LUKE.email);
  });

  // Step 2: Wait for delivery and get UIDs
  it('should find both emails in the mailbox', async () => {
    uidA = await waitForDelivery(LUKE, subjectA);
    uidB = await waitForDelivery(LUKE, subjectB);
    cleanupUids.push(uidA, uidB);
    expect(uidA).toBeDefined();
    expect(uidB).toBeDefined();
    expect(uidA).not.toBe(uidB);
  });

  // Step 3: Simulate "archive locally" by saving the headers of both
  // Step 4: Delete email A from server
  // Step 5: Verify the flag logic
  it('should flag email A as "local-only" after deleting it from server', async () => {
    // Fetch current server state (both emails present)
    const allHeaders = await fetchHeaders(LUKE);
    const emailAHeader = allHeaders.find((e) => e.uid === uidA);
    const emailBHeader = allHeaders.find((e) => e.uid === uidB);
    expect(emailAHeader).toBeDefined();
    expect(emailBHeader).toBeDefined();

    // Simulate "archive locally" — save both email headers as local emails
    const localEmails = [emailAHeader, emailBHeader];
    const archivedEmailIds = new Set([uidA, uidB]);

    // Delete email A from server
    await deleteByUid(LUKE, uidA);
    // Remove from cleanup since it's already deleted
    cleanupUids.splice(cleanupUids.indexOf(uidA), 1);

    // Re-fetch server email list (A is now gone)
    const serverEmailsAfterDelete = await fetchHeaders(LUKE);
    const serverUids = serverEmailsAfterDelete.map((e) => e.uid);
    expect(serverUids).not.toContain(uidA);
    expect(serverUids).toContain(uidB);

    // ----- viewMode: 'all' -----
    const allResult = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: serverEmailsAfterDelete,
      localEmails,
      archivedEmailIds,
      viewMode: 'all',
    });
    const emailAAll = allResult.find((e) => e.uid === uidA);
    const emailBAll = allResult.find((e) => e.uid === uidB);
    expect(emailAAll).toBeDefined();
    expect(emailAAll.source).toBe('local-only');
    expect(emailAAll.isArchived).toBe(true);
    expect(emailBAll.source).toBe('server');

    // ----- viewMode: 'local' -----
    const localResult = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: serverEmailsAfterDelete,
      localEmails,
      archivedEmailIds,
      viewMode: 'local',
    });
    const emailALocal = localResult.find((e) => e.uid === uidA);
    const emailBLocal = localResult.find((e) => e.uid === uidB);
    expect(emailALocal.source).toBe('local-only');
    expect(emailBLocal.source).toBe('local');
  });

  it('should NOT flag emails as "local-only" when server list is empty', () => {
    const localEmails = [
      { uid: uidA, subject: subjectA, date: '2026-02-10T00:00:00Z', from: { address: LUKE.email }, flags: [] },
      { uid: uidB, subject: subjectB, date: '2026-02-10T00:00:00Z', from: { address: LUKE.email }, flags: [] },
    ];

    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [], // Server not loaded yet
      localEmails,
      archivedEmailIds: new Set([uidA, uidB]),
      viewMode: 'local',
    });

    // When server emails haven't loaded, everything should be "local" (not "local-only")
    expect(result.every((e) => e.source === 'local')).toBe(true);
  });
});
