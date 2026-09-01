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

const { useSearchStore, serverSearchTargets, searchScope } = await import('../searchStore');

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

// ── Searching a branch instead of one folder or all of them ────────────────
// bson73: "the structure tells us exactly where something was filed, which lets
// us narrow down search much more effectively." One folder is too narrow and
// all 59 is too wide; the useful scope is the branch.

const box = (path, extra = {}) => ({ path, name: path.split('.').pop(), delimiter: '.', children: [], ...extra });
const NESTED = [
  box('INBOX'),
  box('Kunden'),
  box('Kunden.Company XY'),
  box('Kunden.Company XY.Invoices'),
  box('Kunden.Company XY.Invoices.erledigt'),
  box('Kunden-Alt'),
  box('Sammelmappe', { noselect: true }),
  box('Sammelmappe.Real'),
];
const scopeOf = (folder, activeMailbox = 'INBOX') =>
  searchScope(folder, { activeMailbox, mailboxes: NESTED });

describe('searchScope', () => {
  it('sends "all folders" at every folder the server will open', () => {
    expect(scopeOf('all').targets).toEqual(serverSearchTargets(NESTED));
    expect(scopeOf('all').targets).not.toContain('Sammelmappe');
  });

  it('sends "current folder" at exactly that folder', () => {
    expect(scopeOf('current', 'Kunden.Company XY').targets).toEqual(['Kunden.Company XY']);
  });

  it('treats the unified view as every folder, since it is not a mailbox', () => {
    expect(scopeOf('current', 'UNIFIED').targets).toEqual(serverSearchTargets(NESTED));
  });

  it('sends a named folder at just that folder', () => {
    expect(scopeOf('Kunden.Company XY').targets).toEqual(['Kunden.Company XY']);
  });

  it('sends a branch at the folder and everything filed under it', () => {
    expect(scopeOf('sub:Kunden').targets).toEqual([
      'Kunden', 'Kunden.Company XY', 'Kunden.Company XY.Invoices',
      'Kunden.Company XY.Invoices.erledigt',
    ]);
  });

  it('does not let a branch swallow a sibling whose name it prefixes', () => {
    expect(scopeOf('sub:Kunden').targets).not.toContain('Kunden-Alt');
  });

  it('skips a branch root the server will not open, but keeps its children', () => {
    expect(scopeOf('sub:Sammelmappe').targets).toEqual(['Sammelmappe.Real']);
  });

  it('names one mailbox for the vault when the scope is one folder', () => {
    expect(scopeOf('Kunden.Company XY').localMailbox).toBe('Kunden.Company XY');
    expect(scopeOf('current', 'INBOX').localMailbox).toBe('INBOX');
  });

  it('lets the vault read everything when the scope is wider than one folder', () => {
    expect(scopeOf('all').localMailbox).toBe(null);
    expect(scopeOf('sub:Kunden').localMailbox).toBe(null);
  });

  it('restricts vault rows only for a branch, never for "all folders"', () => {
    // A vault directory for a folder the server no longer lists still holds
    // readable mail, and "all folders" must not discard it.
    expect(scopeOf('all').restrictTo).toBe(null);
    expect([...scopeOf('sub:Kunden').restrictTo]).toContain('Kunden.Company XY');
  });
});

describe('searching a branch', () => {
  it('asks the server about the branch and no other folder', async () => {
    state.mailboxes = NESTED;
    useSearchStore.setState({ searchQuery: 'Rechnung', searchFilters: {
      location: 'all', folder: 'sub:Kunden', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
    } });
    await useSearchStore.getState().performSearch();

    expect(serverCalls).toEqual([
      'Kunden', 'Kunden.Company XY', 'Kunden.Company XY.Invoices',
      'Kunden.Company XY.Invoices.erledigt',
    ]);
  });

  it('drops a vault hit that was filed outside the branch', async () => {
    state.mailboxes = NESTED;
    state.activeMailbox = 'Kunden';
    localResults = [
      { uid: 1, subject: 'Rechnung A', _accountId: 'acct-1', _mailbox: 'Kunden.Company XY.Invoices', source: 'local', from: { address: 'a@b.c' } },
      { uid: 2, subject: 'Rechnung B', _accountId: 'acct-1', _mailbox: 'Kunden-Alt', source: 'local', from: { address: 'a@b.c' } },
    ];
    useSearchStore.setState({ searchQuery: 'Rechnung', searchFilters: {
      location: 'local', folder: 'sub:Kunden', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
    } });
    await useSearchStore.getState().performSearch();

    const found = useSearchStore.getState().searchResults.map(r => r._mailbox);
    expect(found).toContain('Kunden.Company XY.Invoices');
    expect(found).not.toContain('Kunden-Alt');
  });

  it('keeps a vault hit from a folder the server no longer lists, on "all folders"', async () => {
    state.mailboxes = NESTED;
    localResults = [
      { uid: 3, subject: 'Rechnung alt', _accountId: 'acct-1', _mailbox: 'Ehemalige Kunden', source: 'local', from: { address: 'a@b.c' } },
    ];
    useSearchStore.setState({ searchQuery: 'Rechnung', searchFilters: {
      location: 'local', folder: 'all', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
    } });
    await useSearchStore.getState().performSearch();

    expect(useSearchStore.getState().searchResults.map(r => r._mailbox)).toContain('Ehemalige Kunden');
  });
});

describe('searching a branch, continued', () => {
  it('does not surface the open folder in-memory rows when it sits outside the branch', async () => {
    // The loaded headers belong to whatever folder is selected. Searching a
    // branch you are not currently in must not smuggle them in.
    state.mailboxes = NESTED;
    state.activeMailbox = 'Kunden-Alt';
    useSearchStore.setState({ searchQuery: 'Angebot', searchFilters: {
      location: 'all', folder: 'sub:Kunden', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
    } });
    await useSearchStore.getState().performSearch();

    expect(useSearchStore.getState().searchResults.find(r => r.uid === 34)).toBeUndefined();
  });

  it('keeps them when the open folder is inside the branch', async () => {
    state.mailboxes = NESTED;
    state.activeMailbox = 'Kunden.Company XY';
    useSearchStore.setState({ searchQuery: 'Angebot', searchFilters: {
      location: 'all', folder: 'sub:Kunden', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
    } });
    await useSearchStore.getState().performSearch();

    expect(useSearchStore.getState().searchResults.find(r => r.uid === 34)).toBeTruthy();
  });
});
