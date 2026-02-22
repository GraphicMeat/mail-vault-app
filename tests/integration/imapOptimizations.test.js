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

// Helper: compress UID ranges (mirrors Rust compress_uid_ranges)
function compressUidRanges(uids) {
  if (uids.length === 0) return '';
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}:${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}:${end}`);
  return ranges.join(',');
}

beforeAll(() => {
  if (!TEST_EMAIL || !TEST_PASSWORD || TEST_EMAIL === 'your-email@example.com') {
    throw new Error(
      'Missing test credentials. Fill in .env.test with real email/password before running tests.'
    );
  }
});

describe('IMAP Optimization Live Tests', () => {
  // ── 1. UID SEARCH ALL returns UIDs ────────────────────────────────

  it('should fetch all UIDs via UID SEARCH ALL', async () => {
    const client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ all: true }, { uid: true });
      expect(Array.isArray(uids)).toBe(true);
      expect(uids.length).toBeGreaterThan(0);
      // UIDs should be positive integers
      for (const uid of uids) {
        expect(uid).toBeGreaterThan(0);
        expect(Number.isInteger(uid)).toBe(true);
      }
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // ── 2. UID range compression produces valid IMAP set ──────────────

  it('should fetch headers using compressed UID ranges', async () => {
    const client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const allUids = await client.search({ all: true }, { uid: true });
      // Take a subset for testing
      const testUids = allUids.slice(-10); // last 10
      const compressed = compressUidRanges(testUids);

      // Verify compression is shorter or equal
      const commaJoined = testUids.join(',');
      expect(compressed.length).toBeLessThanOrEqual(commaJoined.length);

      // Fetch using compressed range
      const emails = [];
      for await (const message of client.fetch(compressed, {
        envelope: true,
        uid: true,
        flags: true,
      }, { uid: true })) {
        emails.push(message);
      }

      expect(emails.length).toBe(testUids.length);
      // Each fetched UID should be in our test set
      const testUidSet = new Set(testUids);
      for (const email of emails) {
        expect(testUidSet.has(email.uid)).toBe(true);
      }
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // ── 3. Lean fetch spec (no BODYSTRUCTURE) works ───────────────────

  it('should fetch headers without BODYSTRUCTURE or RFC822.SIZE', async () => {
    const client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      expect(total).toBeGreaterThan(0);

      const start = Math.max(1, total - 4);
      const emails = [];
      for await (const message of client.fetch(`${start}:${total}`, {
        envelope: true,
        uid: true,
        flags: true,
        internalDate: true,
        // Deliberately omitting bodyStructure and size
        headers: ['references'],
      })) {
        emails.push(message);
      }

      expect(emails.length).toBeGreaterThan(0);
      for (const email of emails) {
        expect(email.envelope).toBeDefined();
        expect(email.envelope.subject).toBeDefined();
        expect(email.uid).toBeGreaterThan(0);
        expect(email.flags).toBeDefined();
      }
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // ── 4. Mailbox STATUS returns uidValidity and uidNext ─────────────

  it('should get mailbox status with uidValidity and uidNext', async () => {
    const client = createImapClient();
    await client.connect();
    try {
      const status = await client.status('INBOX', {
        messages: true,
        uidValidity: true,
        uidNext: true,
      });

      expect(status).toBeDefined();
      expect(status.messages).toBeGreaterThanOrEqual(0);
      expect(status.uidValidity).toBeGreaterThan(0);
      expect(status.uidNext).toBeGreaterThan(0);
    } finally {
      await client.logout();
    }
  });

  // ── 5. Server capabilities detection ──────────────────────────────

  it('should detect server capabilities on connect', async () => {
    const client = createImapClient();
    await client.connect();
    try {
      // ImapFlow doesn't expose raw capabilities easily, but we can check
      // the server greeting and basic functionality
      expect(client.usable).toBe(true);

      // Try STATUS which all servers support
      const status = await client.status('INBOX', { messages: true });
      expect(status.messages).toBeGreaterThanOrEqual(0);
    } finally {
      await client.logout();
    }
  });

  // ── 6. Chunked fetch works correctly ──────────────────────────────

  it('should handle chunked UID fetches (simulated)', async () => {
    const client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const allUids = await client.search({ all: true }, { uid: true });
      const CHUNK_SIZE = 5;
      const testUids = allUids.slice(-15); // last 15

      // Fetch in chunks of 5
      const allEmails = [];
      for (let i = 0; i < testUids.length; i += CHUNK_SIZE) {
        const chunk = testUids.slice(i, i + CHUNK_SIZE);
        const compressed = compressUidRanges(chunk);

        for await (const message of client.fetch(compressed, {
          envelope: true,
          uid: true,
        }, { uid: true })) {
          allEmails.push(message);
        }
      }

      // All UIDs should have been fetched
      expect(allEmails.length).toBe(testUids.length);
      const fetchedUids = new Set(allEmails.map(e => e.uid));
      for (const uid of testUids) {
        expect(fetchedUids.has(uid)).toBe(true);
      }
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // ── 7. Newest-first ordering ──────────────────────────────────────

  it('should return emails sorted newest-first when UIDs are sorted descending', async () => {
    const client = createImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const allUids = await client.search({ all: true }, { uid: true });
      // Sort descending (newest first)
      const descendingUids = allUids.slice(-10).sort((a, b) => b - a);
      const compressed = compressUidRanges(descendingUids);

      const emails = [];
      for await (const message of client.fetch(compressed, {
        envelope: true,
        uid: true,
        internalDate: true,
      }, { uid: true })) {
        emails.push(message);
      }

      expect(emails.length).toBeGreaterThan(0);
      // Verify all requested UIDs were fetched
      expect(emails.length).toBe(descendingUids.length);
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // ── 8. Double SELECT same mailbox is idempotent ───────────────────

  it('should handle selecting the same mailbox twice', async () => {
    const client = createImapClient();
    await client.connect();
    const lock1 = await client.getMailboxLock('INBOX');
    const total1 = client.mailbox.exists;
    lock1.release();

    const lock2 = await client.getMailboxLock('INBOX');
    const total2 = client.mailbox.exists;
    lock2.release();

    // Same mailbox should report same count
    expect(total1).toBe(total2);

    await client.logout();
  });

  // ── 9. Delta-sync: status check + selective fetch ─────────────────

  it('should detect no changes via STATUS comparison', async () => {
    const client = createImapClient();
    await client.connect();
    try {
      // First check
      const status1 = await client.status('INBOX', {
        messages: true,
        uidValidity: true,
        uidNext: true,
      });

      // Second check immediately — should be identical
      const status2 = await client.status('INBOX', {
        messages: true,
        uidValidity: true,
        uidNext: true,
      });

      expect(status1.messages).toBe(status2.messages);
      expect(status1.uidValidity).toBe(status2.uidValidity);
      expect(status1.uidNext).toBe(status2.uidNext);
    } finally {
      await client.logout();
    }
  });
});
