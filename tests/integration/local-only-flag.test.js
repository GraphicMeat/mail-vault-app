import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSeededServer, createClient, deliver } from './mockHarness.js';
import { deriveDisplayRows } from '../../src/stores/slices/messageListSlice.js';
import { serverUids } from '../../src/stores/slices/serverUids.js';

// The production derivation, imported directly. This file used to call
// `services/emailListUtils.js`, a test-only reimplementation of it that had
// quietly drifted: it stamped `local-only` off a uid set it derived from
// `emails` and assumed complete, so these assertions could pass while the real
// store could not reach that state at all. That file is gone; there is one
// derivation now.
//
// `display()` is a fixture, not a second implementation — it only supplies the
// inputs the old signature left implicit. When a case passes no uid set, it
// means "the emails I passed ARE the whole server", and now says so.
function display({ emails = [], localEmails = [], archivedEmailIds = new Set(), viewMode = 'all', savedEmailIds = new Set(), serverUidSet, serverUidsKnown, ...rest }) {
  return deriveDisplayRows({
    emails, localEmails, archivedEmailIds, viewMode, savedEmailIds, ...rest,
    serverUids: serverUidSet
      ? serverUids(serverUidSet, { complete: !!serverUidsKnown })
      : serverUids(emails.map(e => e.uid), { complete: true }),
  });
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchHeaders(server) {
  const client = createClient(server);
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

async function deleteByUid(server, uid) {
  const client = createClient(server);
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
const LUKE = { email: 'luke@example.test' };
const RUN_ID = Date.now();

describe('Local-Only Flag Detection (send → archive → delete → verify)', () => {
  let server;
  const subjectA = `[LocalOnly-${RUN_ID}] Email A (will be deleted)`;
  const subjectB = `[LocalOnly-${RUN_ID}] Email B (stays on server)`;
  let uidA, uidB;

  beforeAll(async () => {
    server = await startSeededServer({ owner: LUKE.email, inbox: 0 });
  });

  afterAll(async () => {
    server?.stop();
  });

  // Step 1: Send two test emails
  it('should deliver two test emails to Luke', async () => {
    uidA = await deliver(server, {
      from: LUKE.email,
      to: LUKE.email,
      subject: subjectA,
      text: 'This email will be deleted from server but kept locally.',
    });
    uidB = await deliver(server, {
      from: LUKE.email,
      to: LUKE.email,
      subject: subjectB,
      text: 'This email stays on the server.',
    });
    expect(uidA).toBeGreaterThan(0);
    expect(uidB).toBeGreaterThan(0);
    expect(uidA).not.toBe(uidB);
  });

  // Step 2: Confirm both are visible via SEARCH
  it('should find both emails in the mailbox', async () => {
    const client = createClient(server);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidsA = await client.search({ subject: subjectA }, { uid: true });
      const uidsB = await client.search({ subject: subjectB }, { uid: true });
      expect(uidsA).toContain(uidA);
      expect(uidsB).toContain(uidB);
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // Step 3: Simulate "archive locally" by saving the headers of both
  // Step 4: Delete email A from server
  // Step 5: Verify the flag logic
  it('should flag email A as "local-only" after deleting it from server', async () => {
    // Fetch current server state (both emails present)
    const allHeaders = await fetchHeaders(server);
    const emailAHeader = allHeaders.find((e) => e.uid === uidA);
    const emailBHeader = allHeaders.find((e) => e.uid === uidB);
    expect(emailAHeader).toBeDefined();
    expect(emailBHeader).toBeDefined();

    // Simulate "archive locally" — save both email headers as local emails
    const localEmails = [emailAHeader, emailBHeader];
    const archivedEmailIds = new Set([uidA, uidB]);

    // Delete email A from server
    await deleteByUid(server, uidA);

    // Re-fetch server email list (A is now gone)
    const serverEmailsAfterDelete = await fetchHeaders(server);
    const serverUids = serverEmailsAfterDelete.map((e) => e.uid);
    expect(serverUids).not.toContain(uidA);
    expect(serverUids).toContain(uidB);

    // ----- viewMode: 'all' -----
    const allResult = display({
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
    const localResult = display({
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

    const result = display({
      searchActive: false,
      searchResults: [],
      emails: [], // Server not loaded yet
      localEmails,
      archivedEmailIds: new Set([uidA, uidB]),
      viewMode: 'local',
      serverUids: serverUids(new Set(), { complete: false }),
    });

    // Server set is unverified — never flag local-only without proof.
    expect(result.every((e) => e.source === 'local')).toBe(true);
  });
});
