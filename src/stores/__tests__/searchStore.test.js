/**
 * Search is the one list whose rows span folders. Two things went wrong there:
 * the rows carried no location, so opening one fetched the uid from whatever
 * folder was selected; and the dedup key was the bare uid, so folder A's uid 34
 * and folder B's uid 34 collapsed into a single row before anyone clicked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ACTIVE_MAILBOX = 'INBOX.Archive.Projekt Nystart.Lieferanten.CRM Centralstation';

const state = {
  activeAccountId: 'acct-1',
  activeMailbox: ACTIVE_MAILBOX,
  accounts: [{ id: 'acct-1', email: 'a@b.c', password: 'x', imapHost: 'h', imapPort: 993 }],
  savedEmailIds: new Set(),
  emails: [{ uid: 34, subject: 'Angebot CRM', from: { address: 'sales@crm.example' } }],
  localEmails: [],
  mailboxes: [{ path: 'INBOX', children: [] }],
};

let localResults = [];
let serverResults = [];
let localFilters = null;
// mailbox path → rows that server search answers with, when a spec wants the
// folders to differ. Otherwise every folder answers `serverResults`.
let serverByMailbox = null;
let serverCalls = [];
let serverFailIn = new Set();
let serverGate = null;

vi.mock('../mailStore', () => ({ useMailStore: { getState: () => state } }));
vi.mock('../settingsStore', () => ({
  useSettingsStore: { getState: () => ({ addSearchToHistory: () => {} }) },
}));
vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));
vi.mock('../../services/db', () => ({
  searchLocalEmails: (_acct, _q, filters) => { localFilters = filters; return Promise.resolve(localResults); },
}));
vi.mock('../../services/api', () => ({
  searchEmails: async (_acct, mailbox) => {
    serverCalls.push(mailbox);
    if (serverGate) await serverGate;
    if (serverFailIn.has(mailbox)) throw new Error(`SELECT ${mailbox} failed`);
    const emails = serverByMailbox ? (serverByMailbox[mailbox] || []) : serverResults;
    return { emails, total: emails.length };
  },
}));

const { useSearchStore, serverSearchTargets } = await import('../searchStore');

beforeEach(() => {
  localResults = [];
  serverResults = [];
  localFilters = null;
  serverByMailbox = null;
  serverCalls = [];
  serverFailIn = new Set();
  serverGate = null;
  state.mailboxes = [{ path: 'INBOX', children: [] }];
  state.activeMailbox = ACTIVE_MAILBOX;
  useSearchStore.setState({ searchResults: [], searchQuery: '', searchFilters: {
    location: 'all', folder: 'all', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
  } });
});

describe('search results carry their own location', () => {
  it('stamps the active folder on in-memory hits and the searched folder on server hits', async () => {
    serverResults = [{ uid: 77, subject: 'Angebot from server', from: { address: 'sales@crm.example' } }];
    useSearchStore.setState({ searchQuery: 'Angebot' });
    await useSearchStore.getState().performSearch();

    const rows = useSearchStore.getState().searchResults;
    const inMemory = rows.find(r => r.uid === 34);
    const fromServer = rows.find(r => r.uid === 77);
    expect(inMemory._mailbox).toBe(state.activeMailbox);
    expect(inMemory._accountId).toBe('acct-1');
    // folder: 'all' sends the server search at INBOX; the row must say INBOX,
    // not the folder the sidebar has selected.
    expect(fromServer._mailbox).toBe('INBOX');
  });

  it('hands the vault the mailbox list, so its rows can name a real folder', async () => {
    useSearchStore.setState({ searchQuery: 'Angebot' });
    await useSearchStore.getState().performSearch();
    expect(localFilters.mailboxes).toBe(state.mailboxes);
  });

  it('keeps the same uid from two different folders as two rows', async () => {
    localResults = [
      { uid: 34, subject: 'Angebot CRM', _accountId: 'acct-1', _mailbox: 'INBOX.Archive.Lieferanten', source: 'local', from: { address: 'sales@crm.example' } },
      { uid: 34, subject: 'Angebot Nystart', _accountId: 'acct-1', _mailbox: 'INBOX.Archive.Nystart', source: 'local', from: { address: 'sales@crm.example' } },
    ];
    useSearchStore.setState({ searchQuery: 'Angebot' });
    await useSearchStore.getState().performSearch();

    const rows = useSearchStore.getState().searchResults.filter(r => r.uid === 34);
    expect(rows.map(r => r._mailbox).sort()).toEqual([
      'INBOX.Archive.Lieferanten',
      'INBOX.Archive.Nystart',
      state.activeMailbox,
    ].sort());
  });

  it('still collapses the same message found twice in one folder', async () => {
    localResults = [
      { uid: 34, subject: 'Angebot CRM', _accountId: 'acct-1', _mailbox: state.activeMailbox, source: 'local', from: { address: 'sales@crm.example' } },
    ];
    useSearchStore.setState({ searchQuery: 'Angebot' });
    await useSearchStore.getState().performSearch();

    const rows = useSearchStore.getState().searchResults.filter(r => r.uid === 34);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('local');
  });
});

/**
 * "All folders" meant two things in one search: the vault half walked every
 * folder, the server half SELECTed INBOX and stopped. bson73 (discussion #1)
 * has 59 nested folders and a backup that looked smaller than his server —
 * the header said "in all folders" over hits from one of them.
 */
describe('server search covers the folders the UI claims', () => {
  const TREE = [
    { path: 'INBOX', children: [
      { path: 'INBOX.Archive', noselect: true, children: [
        { path: 'INBOX.Archive.Lieferanten', children: [] },
        { path: 'INBOX.Archive.Nystart', children: [] },
      ] },
    ] },
    { path: 'Sent', children: [] },
  ];

  it('SELECTs every selectable folder, INBOX first, containers skipped', async () => {
    state.mailboxes = TREE;
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'all', location: 'server' });
    await useSearchStore.getState().performSearch();

    expect(serverCalls).toEqual([
      'INBOX',
      'INBOX.Archive.Lieferanten',
      'INBOX.Archive.Nystart',
      'Sent',
    ]);
  });

  it('returns a hit that lives in a folder other than INBOX', async () => {
    state.mailboxes = TREE;
    serverByMailbox = {
      'INBOX.Archive.Nystart': [{ uid: 7, subject: 'Angebot Nystart', from: { address: 'sales@crm.example' } }],
    };
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'all', location: 'server' });
    await useSearchStore.getState().performSearch();

    const hit = useSearchStore.getState().searchResults.find(r => r.uid === 7);
    expect(hit).toBeTruthy();
    // The row has to name the folder it was found in, or opening it fetches
    // uid 7 from whatever the sidebar has selected.
    expect(hit._mailbox).toBe('INBOX.Archive.Nystart');
  });

  it('keeps the other folders when one folder refuses', async () => {
    state.mailboxes = TREE;
    serverFailIn = new Set(['INBOX.Archive.Lieferanten']);
    serverByMailbox = {
      'Sent': [{ uid: 9, subject: 'Angebot Sent', from: { address: 'me@crm.example' } }],
    };
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'all', location: 'server' });
    await useSearchStore.getState().performSearch();

    expect(serverCalls).toContain('Sent');
    expect(useSearchStore.getState().searchResults.map(r => r.uid)).toContain(9);
  });

  it('searches only the picked folder when the user picks one', async () => {
    state.mailboxes = TREE;
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'Sent', location: 'server' });
    await useSearchStore.getState().performSearch();
    expect(serverCalls).toEqual(['Sent']);
  });

  it('searches only the active folder for "current"', async () => {
    state.mailboxes = TREE;
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'current', location: 'server' });
    await useSearchStore.getState().performSearch();
    expect(serverCalls).toEqual([ACTIVE_MAILBOX]);
  });

  it('fans out for "current" in the unified view, which is not a mailbox', async () => {
    state.mailboxes = TREE;
    state.activeMailbox = 'UNIFIED';
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'current', location: 'server' });
    await useSearchStore.getState().performSearch();
    // SELECT UNIFIED is an error, and the view it names is every folder.
    expect(serverCalls).not.toContain('UNIFIED');
    expect(serverCalls).toEqual(['INBOX', 'INBOX.Archive.Lieferanten', 'INBOX.Archive.Nystart', 'Sent']);
  });

  it('reports progress while the sweep runs and clears it at the end', async () => {
    state.mailboxes = TREE;
    const seen = [];
    const unsub = useSearchStore.subscribe((s) => seen.push(s.searchProgress));
    useSearchStore.setState({ searchQuery: 'Angebot' });
    useSearchStore.getState().setSearchFilters({ folder: 'all', location: 'server' });
    await useSearchStore.getState().performSearch();
    unsub();

    expect(seen).toContainEqual({ done: 4, total: 4 });
    expect(useSearchStore.getState().searchProgress).toBeNull();
  });

  it('a newer search discards the sweep the old query started', async () => {
    state.mailboxes = TREE;
    let release;
    serverGate = new Promise((r) => { release = r; });
    serverByMailbox = { 'INBOX': [{ uid: 1, subject: 'Stale', from: { address: 's@x.y' } }] };

    useSearchStore.setState({ searchQuery: 'Stale' });
    useSearchStore.getState().setSearchFilters({ folder: 'all', location: 'server' });
    const stale = useSearchStore.getState().performSearch();

    // Second search wins; the first is still on the wire.
    serverGate = null;
    serverByMailbox = { 'INBOX': [{ uid: 2, subject: 'Fresh', from: { address: 's@x.y' } }] };
    useSearchStore.setState({ searchQuery: 'Fresh' });
    await useSearchStore.getState().performSearch();

    release();
    await stale;

    const subjects = useSearchStore.getState().searchResults.map(r => r.subject);
    expect(subjects).toContain('Fresh');
    expect(subjects).not.toContain('Stale');
  });
});

describe('serverSearchTargets', () => {
  it('skips \\Noselect containers, dedupes, and leads with INBOX', () => {
    expect(serverSearchTargets([
      { path: 'Sent', children: [] },
      { path: 'Placeholder', noselect: true, children: [{ path: 'Placeholder.Real', children: [] }] },
      { path: 'INBOX', children: [{ path: 'Sent', children: [] }] },
    ])).toEqual(['INBOX', 'Sent', 'Placeholder.Real']);
  });

  it('is empty when the tree is', () => {
    expect(serverSearchTargets(undefined)).toEqual([]);
  });
});
