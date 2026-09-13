/**
 * Vault search answers from the offline index (`vault_search`) when the app
 * has one open, and from today's per-message scan when it does not. Index rows
 * reach the same list and viewer code as vault rows, so they have to be
 * decorated exactly like `getLocalEmails` decorates them: the server path the
 * vault directory came from, provenance, and custody off local-index.json.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const calls = [];
let vaultSearchReply = null;
let localIndexByMailbox = {};

vi.mock('../../transport.js', () => ({
  send: vi.fn(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'vault_search') {
      if (vaultSearchReply instanceof Error) throw vaultSearchReply;
      return vaultSearchReply;
    }
    if (cmd === 'local_index_read') return JSON.stringify(localIndexByMailbox[args.mailbox] || []);
    if (cmd === 'maildir_repair_generation') return { status: 'ok' };
    if (cmd === 'maildir_list') return [];
    return null;
  }),
}));

vi.mock('../accounts.js', () => ({
  initDB: vi.fn(async () => {}),
  initBasic: vi.fn(async () => {}),
  accountDir: () => 'acct',
}));

const { searchLocalEmails } = await import('../emails.js');

const mailboxes = [{ path: 'INBOX' }, { path: 'Projects/2026' }];

beforeEach(() => { calls.length = 0; localIndexByMailbox = {}; });

describe('searchLocalEmails answers from the index', () => {
  it('maps vault dirs back to server paths and stamps rows like getLocalEmails', async () => {
    vaultSearchReply = {
      available: true, total: 2, indexed: 10, totalMessages: 12, complete: false,
      rows: [
        { uid: 7, subject: 'Plan', flags: ['archived', 'seen', '\\Seen'], isArchived: true, vaultDir: 'Projects_2026', matchedIn: ['body'], snippet: '…plan…' },
        { uid: 3, subject: 'Hi', flags: [], isArchived: false, vaultDir: 'INBOX', matchedIn: ['subject'], snippet: null },
      ],
    };
    localIndexByMailbox['Projects/2026'] = [{ uid: 7, source: 'local_sent', serverDeleted: true }];
    const rows = await searchLocalEmails('acct-1', 'plan', { mailboxes });
    expect(rows.map(r => [r._mailbox, r.uid])).toEqual([['Projects/2026', 7], ['INBOX', 3]]);
    expect(rows[0]).toMatchObject({ _accountId: 'acct-1', localId: 'acct-1-Projects/2026-7', isLocal: true, isArchived: true, _origin: 'local_sent', serverDeleted: true, matchedIn: ['body'] });
    expect(rows[0].source).not.toBe('local'); // custodySource decides, not a constant
    expect(rows.coverage).toEqual({ indexed: 10, total: 12, complete: false, matched: 2, shown: 2 });
    const req = calls.find(([c]) => c === 'vault_search')[1].request;
    expect(req).toMatchObject({ accountId: 'acct-1', query: 'plan', mailboxes: null });
  });

  it('sends one mailbox, a branch, sender, dates as unix seconds, attachments', async () => {
    vaultSearchReply = { available: true, rows: [], total: 0, indexed: 0, totalMessages: 0, complete: true };
    await searchLocalEmails('acct-1', '', { mailbox: 'INBOX', sender: 'ann', dateFrom: '2026-09-08', dateTo: '2026-09-09T23:59:59Z', hasAttachments: true, mailboxes });
    let req = calls.find(([c]) => c === 'vault_search')[1].request;
    expect(req).toMatchObject({ mailboxes: ['INBOX'], sender: 'ann', dateFrom: 1788825600, dateTo: 1788998399, hasAttachments: true });
    calls.length = 0;
    await searchLocalEmails('acct-1', 'x', { restrictTo: ['Projects', 'Projects/2026'], mailboxes });
    req = calls.find(([c]) => c === 'vault_search')[1].request;
    expect(req.mailboxes).toEqual(['Projects', 'Projects/2026']);
  });

  it('names a one-folder hit by the folder searched, even one the tree does not list', async () => {
    vaultSearchReply = {
      available: true, total: 1, indexed: 1, totalMessages: 1, complete: true,
      rows: [{ uid: 5, subject: 'Old', flags: [], isArchived: true, vaultDir: 'Old_Clients', matchedIn: ['subject'], snippet: null }],
    };
    const rows = await searchLocalEmails('acct-1', 'old', { mailbox: 'Old Clients', mailboxes });
    expect(rows[0]).toMatchObject({ _mailbox: 'Old Clients', localId: 'acct-1-Old Clients-5' });
  });

  it('says how many matched when the index capped the rows', async () => {
    vaultSearchReply = {
      available: true, total: 1234, indexed: 5000, totalMessages: 5000, complete: true,
      rows: [{ uid: 9, subject: 'Newest', flags: [], isArchived: false, vaultDir: 'INBOX', matchedIn: ['subject'], snippet: null }],
    };
    const rows = await searchLocalEmails('acct-1', 'newest', { mailboxes });
    expect(rows.coverage).toMatchObject({ matched: 1234, shown: 1 });
  });

  it('falls back to scanning the vault when the index is unavailable', async () => {
    vaultSearchReply = { available: false };
    const rows = await searchLocalEmails('acct-1', 'plan', { mailbox: 'INBOX', mailboxes });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.coverage).toBeUndefined();
    expect(calls.some(([c]) => c === 'maildir_list')).toBe(true);
  });

  it('falls back to scanning the vault when vault_search throws', async () => {
    vaultSearchReply = new Error('command vault_search not found');
    const rows = await searchLocalEmails('acct-1', 'plan', { mailbox: 'INBOX', mailboxes });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.coverage).toBeUndefined();
    expect(calls.some(([c]) => c === 'maildir_list')).toBe(true);
  });
});
