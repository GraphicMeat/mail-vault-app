/**
 * Clicking a folder that has children lists the whole branch.
 *
 * There is no server primitive for "everything under here" — `UID SEARCH ALL`
 * is unusable (src-core/src/imap/mod.rs), and loadEmails is single-mailbox by
 * construction. So this fans the existing per-mailbox lister across the branch
 * and merges, the way the search fan-out already does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ACCOUNT = { id: 'acct-1', email: 'a@b.c', password: 'x', imapHost: 'h', imapPort: 993 };

const box = (path, extra = {}) => ({
  path, name: path.split('/').pop(), delimiter: '/', noselect: false, children: [], ...extra,
});
const MAILBOXES = [
  box('INBOX'),
  box('Kunden'),
  box('Kunden/Company XY'),
  box('Kunden/Company XY/Invoices'),
  box('Kunden/Sammelmappe', { noselect: true }),
  box('Kunden/Sammelmappe/Real'),
  box('Kunden-Alt'),
];

let state;
let setCalls;
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => state,
    setState: (patch) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      setCalls.push(next);
    },
  },
}));
vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));

let statusByMailbox;
let emailsByMailbox;
let failIn;
let gate;
let statusCalls;
let fetchCalls;
vi.mock('../../api', () => ({
  checkMailboxStatus: async (_a, mailbox) => {
    statusCalls.push(mailbox);
    if (failIn.has(mailbox)) throw new Error(`SELECT ${mailbox} failed`);
    return { exists: statusByMailbox[mailbox] ?? 0, uidValidity: 1, uidNext: 99 };
  },
  fetchEmails: async (_a, mailbox) => {
    fetchCalls.push(mailbox);
    if (gate && gate.mailbox === mailbox) await gate.promise;
    if (failIn.has(mailbox)) throw new Error(`SELECT ${mailbox} failed`);
    const emails = emailsByMailbox[mailbox] || [];
    return { emails, total: emails.length, has_more: false };
  },
}));

const msg = (uid, day) => ({
  uid, subject: `m${uid}`, flags: [], from: { address: 's@x.y' },
  date: `2026-08-${String(day).padStart(2, '0')}T10:00:00Z`,
});

const { loadSubtree } = await import('../loadSubtree');

beforeEach(() => {
  statusByMailbox = {};
  emailsByMailbox = {};
  failIn = new Set();
  gate = null;
  statusCalls = [];
  fetchCalls = [];
  setCalls = [];
  state = {
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    mailboxes: MAILBOXES,
    emails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    totalEmails: 0,
    loading: false,
    updateSortedEmails: vi.fn(),
  };
});

describe('loadSubtree', () => {
  it('scopes the list to the branch, leaving out a container the server will not open', async () => {
    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.activeMailbox).toBe('Kunden');
    expect(state.mailboxScope.root).toBe('Kunden');
    expect(state.mailboxScope.paths).toEqual([
      'Kunden', 'Kunden/Company XY', 'Kunden/Company XY/Invoices', 'Kunden/Sammelmappe/Real',
    ]);
  });

  it('does not let the branch swallow a sibling whose name it prefixes', async () => {
    await loadSubtree(ACCOUNT.id, 'Kunden');
    expect(state.mailboxScope.paths).not.toContain('Kunden-Alt');
  });

  it('counts what the server says is in the whole branch, not what it fetched', async () => {
    statusByMailbox = {
      'Kunden': 3, 'Kunden/Company XY': 1200,
      'Kunden/Company XY/Invoices': 40, 'Kunden/Sammelmappe/Real': 7,
    };
    emailsByMailbox = { 'Kunden': [msg(1, 1)] };

    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.totalEmails).toBe(1250);
  });

  it('stamps every row with the folder it actually came from', async () => {
    emailsByMailbox = {
      'Kunden': [msg(1, 1)],
      'Kunden/Company XY': [msg(2, 2)],
    };

    await loadSubtree(ACCOUNT.id, 'Kunden');

    const byUid = Object.fromEntries(state.emails.map(e => [e.uid, e]));
    expect(byUid[1]._mailbox).toBe('Kunden');
    expect(byUid[2]._mailbox).toBe('Kunden/Company XY');
    expect(state.emails.every(e => e._accountId === ACCOUNT.id)).toBe(true);
  });

  it('merges the folders newest first', async () => {
    emailsByMailbox = {
      'Kunden': [msg(1, 5)],
      'Kunden/Company XY': [msg(2, 20)],
      'Kunden/Company XY/Invoices': [msg(3, 12)],
    };

    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.emails.map(e => e.uid)).toEqual([2, 3, 1]);
  });

  it('keeps the same uid from two folders as two rows', async () => {
    emailsByMailbox = {
      'Kunden': [msg(34, 5)],
      'Kunden/Company XY': [msg(34, 6)],
    };

    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.emails).toHaveLength(2);
    expect(state.emails.map(e => e._mailbox).sort()).toEqual(['Kunden', 'Kunden/Company XY']);
  });

  it('puts rows on screen as each folder answers, not only at the end', async () => {
    // A branch of 23 folders takes long enough that a list which fills only at
    // the end reads as a folder that found nothing.
    let release;
    gate = { mailbox: 'Kunden/Company XY/Invoices', promise: new Promise(r => { release = r; }) };
    emailsByMailbox = {
      'Kunden': [msg(1, 1)],
      'Kunden/Company XY': [msg(2, 2)],
      'Kunden/Company XY/Invoices': [msg(3, 3)],
    };

    const run = loadSubtree(ACCOUNT.id, 'Kunden');
    await vi.waitFor(() => expect(state.emails.length).toBeGreaterThan(0));
    const early = state.emails.length;
    release();
    await run;

    expect(early).toBeLessThan(state.emails.length);
  });

  it('does not lose 22 readable folders to one that is not', async () => {
    failIn = new Set(['Kunden/Company XY']);
    emailsByMailbox = {
      'Kunden': [msg(1, 1)],
      'Kunden/Company XY/Invoices': [msg(3, 3)],
    };

    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.emails.map(e => e.uid).sort()).toEqual([1, 3]);
    expect(state.loading).toBe(false);
  });

  it('stops when the account changed underneath it', async () => {
    let release;
    gate = { mailbox: 'Kunden', promise: new Promise(r => { release = r; }) };
    emailsByMailbox = { 'Kunden': [msg(1, 1)], 'Kunden/Company XY': [msg(2, 2)] };

    const run = loadSubtree(ACCOUNT.id, 'Kunden');
    await vi.waitFor(() => expect(fetchCalls).toContain('Kunden'));
    state.activeAccountId = 'someone-else';
    release();
    await run;

    expect(state.emails).toEqual([]);
  });

  it('repaints the list after each folder, not only the store', async () => {
    // sortedEmails is recomputed by an explicit call, not derived — so a load
    // that writes `emails` and stops leaves the list showing the folder before.
    emailsByMailbox = { 'Kunden': [msg(1, 1)], 'Kunden/Company XY': [msg(2, 2)] };

    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.updateSortedEmails.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('drops the previous folder vault rows instead of showing them under the branch', async () => {
    state.localEmails = [{ uid: 500, _mailbox: 'INBOX', subject: 'from the folder before' }];

    await loadSubtree(ACCOUNT.id, 'Kunden');

    expect(state.localEmails).toEqual([]);
  });

  it('clears the scope when an ordinary folder is opened again', async () => {
    await loadSubtree(ACCOUNT.id, 'Kunden');
    expect(state.mailboxScope).not.toBe(null);

    await loadSubtree(ACCOUNT.id, 'INBOX');
    // INBOX has no children here — a leaf is an ordinary folder, not a branch.
    expect(state.mailboxScope).toBe(null);
  });
});

// ── The scope must not outlive the branch ──────────────────────────────────
// `unifiedInbox: false` and `mailboxScope: null` say the same thing: this list
// no longer spans mailboxes. Clearing one without the other leaves every row
// action resolving per-row in a list where activeMailbox is the whole truth.
describe('opening an ordinary folder', () => {
  it('clears the branch scope wherever activateAccount clears the unified flag', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/workflows/activateAccount.js'), 'utf8');

    const lines = src.split('\n');
    const orphans = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /unifiedInbox:\s*false/.test(l))
      .filter(({ i }) => !/mailboxScope:\s*null/.test(lines[i + 1] || ''))
      .map(({ i }) => `activateAccount.js:${i + 1}`);

    expect(orphans).toEqual([]);
  });

  it('clears it on the fallback that gives up and opens INBOX', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/workflows/activateAccount.js'), 'utf8');

    expect(src).toContain("setState({ activeMailbox: 'INBOX', mailboxScope: null })");
  });
});
