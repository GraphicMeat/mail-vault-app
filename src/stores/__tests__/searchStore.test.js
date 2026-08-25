/**
 * Search is the one list whose rows span folders. Two things went wrong there:
 * the rows carried no location, so opening one fetched the uid from whatever
 * folder was selected; and the dedup key was the bare uid, so folder A's uid 34
 * and folder B's uid 34 collapsed into a single row before anyone clicked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  activeAccountId: 'acct-1',
  activeMailbox: 'INBOX.Archive.Projekt Nystart.Lieferanten.CRM Centralstation',
  accounts: [{ id: 'acct-1', email: 'a@b.c', password: 'x', imapHost: 'h', imapPort: 993 }],
  savedEmailIds: new Set(),
  emails: [{ uid: 34, subject: 'Angebot CRM', from: { address: 'sales@crm.example' } }],
  localEmails: [],
  mailboxes: [{ path: 'INBOX', children: [] }],
};

let localResults = [];
let serverResults = [];
let localFilters = null;

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
  searchEmails: () => Promise.resolve({ emails: serverResults, total: serverResults.length }),
}));

const { useSearchStore } = await import('../searchStore');

beforeEach(() => {
  localResults = [];
  serverResults = [];
  localFilters = null;
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
