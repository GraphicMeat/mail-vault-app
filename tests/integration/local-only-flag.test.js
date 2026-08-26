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
function display({ emails = [], localEmails = [], archivedEmailIds = new Set(), viewMode = 'all', savedEmailIds = new Set(), serverUidSet, serverUidsKnown, serverUids: explicitServerUids, ...rest }) {
  // A caller that builds the pair itself wins. It used to lose: the key was
  // overwritten below and the fallback claimed COMPLETE, so the one case that
  // passed an unverified empty set was handed the strongest possible claim —
  // "the server holds nothing" — and asserted the opposite of what it read.
  const resolved = explicitServerUids
    || (serverUidSet
      ? serverUids(serverUidSet, { complete: !!serverUidsKnown })
      : serverUids(emails.map(e => e.uid), { complete: true }));
  return deriveDisplayRows({
    emails, localEmails, archivedEmailIds, viewMode, savedEmailIds, ...rest,
    serverUids: resolved,
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
    const archivedEmailIds = new Set([uidA, uidB]);

    // Delete email A from server
    await deleteByUid(server, uidA);

    // …and record it on the vault copy, which is the other half of what the
    // app's delete does (`applyServerRemoval` → `markServerDeleted`, written
    // into local-index.json and read back onto the row). That stamp is what
    // makes the row local-only now: "absent from this mailbox's uid set" is a
    // mailbox fact, and a message can leave INBOX for All Mail, a label or the
    // Bin and still be on the server. See stores/slices/custody.js.
    const localEmails = [{ ...emailAHeader, serverDeleted: true }, emailBHeader];

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
      // Nothing has enumerated the mailbox yet: an empty set with no
      // completeness claim, which is not the same as "the server is empty".
      serverUidSet: new Set(),
      serverUidsKnown: false,
    });

    // Server set is unverified — never flag local-only without proof.
    expect(result.length).toBe(2);
    expect(result.every((e) => e.source === 'local')).toBe(true);

    // The assertion above only means something if the same rows DO flip when
    // there is real proof — otherwise it would pass on a derivation that can
    // never say 'local-only' at all. Proof is the stamp on the message, not a
    // completeness flag on a uid set: a COMPLETE enumeration of one mailbox
    // still says nothing about the rest of the account.
    const stillUnproven = display({
      searchActive: false,
      searchResults: [],
      emails: [],
      localEmails,
      archivedEmailIds: new Set([uidA, uidB]),
      viewMode: 'local',
      serverUidSet: new Set(),
      serverUidsKnown: true,
    });
    expect(stillUnproven.every((e) => e.source === 'local')).toBe(true);

    const proven = display({
      searchActive: false,
      searchResults: [],
      emails: [],
      localEmails: localEmails.map((e) => ({ ...e, serverDeleted: true })),
      archivedEmailIds: new Set([uidA, uidB]),
      viewMode: 'local',
      serverUidSet: new Set(),
      serverUidsKnown: false,
    });
    expect(proven.every((e) => e.source === 'local-only')).toBe(true);
  });

  it('should flag emails "local-only" when a completed folder sweep found nothing', () => {
    // The third proof, and the only one that covers a deletion this app did not
    // make. The sweep itself is IMAP — src-core/tests/imap_search.rs drives it
    // against this same protocol — and `serverAbsent` is what it writes down.
    // This asserts the display rows honour that stamp, and that a sweep which
    // wrote no stamp leaves the rows quiet.
    const localEmails = [
      { uid: uidA, subject: subjectA, date: '2026-02-10T00:00:00Z', from: { address: LUKE.email }, flags: [] },
      { uid: uidB, subject: subjectB, date: '2026-02-10T00:00:00Z', from: { address: LUKE.email }, flags: [] },
    ];
    const base = {
      searchActive: false,
      searchResults: [],
      emails: [],
      archivedEmailIds: new Set([uidA, uidB]),
      viewMode: 'local',
      // A COMPLETE enumeration of this mailbox that still lists both messages:
      // the uid set says nothing either way, and must not.
      serverUidSet: new Set([uidA, uidB]),
      serverUidsKnown: true,
    };

    const swept = display({ ...base, localEmails: localEmails.map((e) => ({ ...e, serverAbsent: true })) });
    expect(swept.every((e) => e.source === 'local-only')).toBe(true);

    // A sweep that could not open every folder writes nothing at all, and a
    // `false` written when the message turned out to be present is not
    // evidence of anything either.
    const unswept = display({ ...base, localEmails: localEmails.map((e) => ({ ...e, serverAbsent: false })) });
    expect(unswept.every((e) => e.source === 'local')).toBe(true);
  });
});
