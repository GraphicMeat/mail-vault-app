import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { vaultAdoptMailboxDirs: vi.fn() };
vi.mock('../../api', () => api);

let settingsState;
// `persist` hangs off the store object, not off its state, and each test picks
// its own hydration stage.
let settingsPersist;
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => settingsState,
    get persist() { return settingsPersist; },
  },
}));

const { adoptGraphFolderKeys, adoptGraphFolderKeysFromListing, LEGACY_LOCALIZED_KEYS } =
  await import('../adoptGraphFolderKeys');

const GRAPH = { id: 'g1', email: 'leia@mock.test', authType: 'oauth2', oauth2Transport: 'graph' };
const IMAP = { id: 'i1', email: 'luke@mock.test', authType: 'password', imapHost: '127.0.0.1' };

/** What a German Outlook mailbox lists: every default folder named in the
 *  server's language, plus one folder the user made. */
const GERMAN_LISTING = [
  { id: 'f1', displayName: 'Posteingang', wellKnownName: 'inbox', storageKey: 'INBOX' },
  { id: 'f2', displayName: 'Gesendete Elemente', wellKnownName: 'sentitems', storageKey: 'Sent' },
  { id: 'f3', displayName: 'Entwürfe', wellKnownName: 'drafts', storageKey: 'Drafts' },
  { id: 'f4', displayName: 'Gelöschte Elemente', wellKnownName: 'deleteditems', storageKey: 'Trash' },
  { id: 'f5', displayName: 'Junk-E-Mail', wellKnownName: 'junkemail', storageKey: 'Junk' },
  { id: 'f6', displayName: 'Archiv', wellKnownName: 'archive', storageKey: 'Archive' },
  { id: 'f7', displayName: 'Projekte', wellKnownName: null, storageKey: 'Projekte' },
];

/** An English mailbox: `Drafts` and `Archive` already equal their keys, the
 *  other four do not. */
const ENGLISH_LISTING = [
  { id: 'f1', displayName: 'Inbox', wellKnownName: 'inbox', storageKey: 'INBOX' },
  { id: 'f2', displayName: 'Sent Items', wellKnownName: 'sentitems', storageKey: 'Sent' },
  { id: 'f3', displayName: 'Drafts', wellKnownName: 'drafts', storageKey: 'Drafts' },
  { id: 'f4', displayName: 'Deleted Items', wellKnownName: 'deleteditems', storageKey: 'Trash' },
  { id: 'f5', displayName: 'Junk Email', wellKnownName: 'junkemail', storageKey: 'Junk' },
  { id: 'f6', displayName: 'Archive', wellKnownName: 'archive', storageKey: 'Archive' },
];

beforeEach(() => {
  api.vaultAdoptMailboxDirs.mockReset().mockResolvedValue({ adopted: [], skipped_both_exist: [], failed: [] });
  settingsPersist = undefined;
  settingsState = {
    graphFolderKeysAdopted: {},
    graphFolderKeysAdoptedFromListing: {},
    lastMailboxPerAccount: {},
    getLastMailbox: (id) => settingsState.lastMailboxPerAccount[id] || 'INBOX',
    setLastMailbox: vi.fn((id, m) => { settingsState.lastMailboxPerAccount[id] = m; }),
    markGraphFolderKeysAdopted: vi.fn((id) => { settingsState.graphFolderKeysAdopted[id] = true; }),
    markGraphFolderKeysAdoptedFromListing: vi.fn((id) => { settingsState.graphFolderKeysAdoptedFromListing[id] = true; }),
  };
});

describe('LEGACY_LOCALIZED_KEYS', () => {
  it('is the frozen table of what v2.11.0 through v2.13.1 wrote: 38 distinct words onto five keys', () => {
    expect(LEGACY_LOCALIZED_KEYS).toHaveLength(38);
    expect(new Set(LEGACY_LOCALIZED_KEYS.map(([from]) => from)).size).toBe(38);
    expect(new Set(LEGACY_LOCALIZED_KEYS.map(([, to]) => to))).toEqual(new Set(['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']));
    expect(LEGACY_LOCALIZED_KEYS).toContainEqual(['Gesendet', 'Sent']);
    expect(LEGACY_LOCALIZED_KEYS).toContainEqual(['Archivieren', 'Archive']);
    expect(LEGACY_LOCALIZED_KEYS).toContainEqual(['Lixo eletrônico', 'Junk']);
    expect(LEGACY_LOCALIZED_KEYS.some(([from]) => from === 'Junk')).toBe(false);
  });
});

describe('adoptGraphFolderKeys', () => {
  it('ignores accounts that are not Graph', async () => {
    await adoptGraphFolderKeys([IMAP]);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
    expect(settingsState.markGraphFolderKeysAdopted).not.toHaveBeenCalled();
  });

  it('sends every legacy pair for a Graph account and remembers the adoption', async () => {
    await adoptGraphFolderKeys([GRAPH]);
    expect(api.vaultAdoptMailboxDirs).toHaveBeenCalledTimes(1);
    const [id, email, pairs] = api.vaultAdoptMailboxDirs.mock.calls[0];
    expect(id).toBe('g1');
    expect(email).toBe('leia@mock.test');
    expect(pairs).toHaveLength(38);
    expect(pairs).toContainEqual({ from: 'Papierkorb', to: 'Trash' });
    expect(settingsState.markGraphFolderKeysAdopted).toHaveBeenCalledWith('g1');
  });

  it('runs once: a flagged account makes no IPC', async () => {
    settingsState.graphFolderKeysAdopted = { g1: true };
    await adoptGraphFolderKeys([GRAPH]);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
  });

  it('leaves the flag unset when the command fails, so the next launch retries, and does not throw', async () => {
    api.vaultAdoptMailboxDirs.mockRejectedValue(new Error('disk'));
    await expect(adoptGraphFolderKeys([GRAPH])).resolves.toBeUndefined();
    expect(settingsState.markGraphFolderKeysAdopted).not.toHaveBeenCalled();
  });

  it('rewrites a remembered last mailbox that was a localized key', async () => {
    settingsState.lastMailboxPerAccount = { g1: 'Gesendet' };
    await adoptGraphFolderKeys([GRAPH]);
    expect(settingsState.setLastMailbox).toHaveBeenCalledWith('g1', 'Sent');
  });

  it('leaves a remembered last mailbox alone when it is not a legacy word', async () => {
    settingsState.lastMailboxPerAccount = { g1: 'Projekte' };
    await adoptGraphFolderKeys([GRAPH]);
    expect(settingsState.setLastMailbox).not.toHaveBeenCalled();
  });

  it('handles several accounts, Graph and not, in one call', async () => {
    const g2 = { ...GRAPH, id: 'g2', email: 'han@mock.test' };
    await adoptGraphFolderKeys([IMAP, GRAPH, g2]);
    expect(api.vaultAdoptMailboxDirs.mock.calls.map(([id]) => id)).toEqual(['g1', 'g2']);
  });

  // The persisted settings arrive over IPC and the merge lets them win, so a
  // flag written before hydration is thrown away — and the account would be
  // adopted again on the next launch, after the app had already opened its
  // folders under the new key.
  it('waits for the persisted settings before reading the flag', async () => {
    settingsPersist = {
      hasHydrated: () => false,
      onFinishHydration: (cb) => {
        setTimeout(() => { settingsState.graphFolderKeysAdopted = { g1: true }; cb(); }, 0);
        return () => {};
      },
    };
    await adoptGraphFolderKeys([GRAPH]);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
  });

  it('does not wait when the store has already hydrated', async () => {
    const onFinishHydration = vi.fn();
    settingsPersist = { hasHydrated: () => true, onFinishHydration };
    await adoptGraphFolderKeys([GRAPH]);
    expect(onFinishHydration).not.toHaveBeenCalled();
    expect(api.vaultAdoptMailboxDirs).toHaveBeenCalledTimes(1);
    expect(settingsState.markGraphFolderKeysAdopted).toHaveBeenCalledWith('g1');
  });

  it('leaves the flag unset and logs when the report carries a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.vaultAdoptMailboxDirs.mockResolvedValue({ adopted: [], skipped_both_exist: [], failed: ['x'] });
    await adoptGraphFolderKeys([GRAPH]);
    expect(settingsState.markGraphFolderKeysAdopted).not.toHaveBeenCalled();
    expect(settingsState.setLastMailbox).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('adoptGraphFolderKeysFromListing', () => {
  it('adopts every well-known folder the server named in its own language', async () => {
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    expect(api.vaultAdoptMailboxDirs).toHaveBeenCalledTimes(1);
    const [id, email, pairs] = api.vaultAdoptMailboxDirs.mock.calls[0];
    expect(id).toBe('g1');
    expect(email).toBe('leia@mock.test');
    expect(pairs).toEqual([
      { from: 'Posteingang', to: 'INBOX' },
      { from: 'Gesendete Elemente', to: 'Sent' },
      { from: 'Entwürfe', to: 'Drafts' },
      { from: 'Gelöschte Elemente', to: 'Trash' },
      { from: 'Junk-E-Mail', to: 'Junk' },
      { from: 'Archiv', to: 'Archive' },
    ]);
    expect(settingsState.markGraphFolderKeysAdoptedFromListing).toHaveBeenCalledWith('g1');
  });

  it('skips a custom folder, which was never keyed by anything else', async () => {
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    const [, , pairs] = api.vaultAdoptMailboxDirs.mock.calls[0];
    expect(pairs.some(p => p.from === 'Projekte' || p.to === 'Projekte')).toBe(false);
  });

  it('sends only the English names that differ from their key, and still flags', async () => {
    await adoptGraphFolderKeysFromListing(GRAPH, ENGLISH_LISTING);
    const [, , pairs] = api.vaultAdoptMailboxDirs.mock.calls[0];
    expect(pairs).toEqual([
      { from: 'Inbox', to: 'INBOX' },
      { from: 'Sent Items', to: 'Sent' },
      { from: 'Deleted Items', to: 'Trash' },
      { from: 'Junk Email', to: 'Junk' },
    ]);
    expect(settingsState.markGraphFolderKeysAdoptedFromListing).toHaveBeenCalledWith('g1');
  });

  it('ignores an account that is not Graph', async () => {
    await adoptGraphFolderKeysFromListing(IMAP, GERMAN_LISTING);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
    expect(settingsState.markGraphFolderKeysAdoptedFromListing).not.toHaveBeenCalled();
  });

  it('runs once: a flagged account makes no IPC on the next listing', async () => {
    settingsState.graphFolderKeysAdoptedFromListing = { g1: true };
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
  });

  it('flags an all-English listing with nothing to move without any IPC', async () => {
    await adoptGraphFolderKeysFromListing(GRAPH, [
      { id: 'f1', displayName: 'Drafts', wellKnownName: 'drafts', storageKey: 'Drafts' },
      { id: 'f2', displayName: 'Projekte', wellKnownName: null, storageKey: 'Projekte' },
    ]);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
    expect(settingsState.markGraphFolderKeysAdoptedFromListing).toHaveBeenCalledWith('g1');
  });

  it('leaves the flag unset when the report carries a failure, so the next listing retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.vaultAdoptMailboxDirs.mockResolvedValue({ adopted: [], skipped_both_exist: [], failed: ['x'] });
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    expect(settingsState.markGraphFolderKeysAdoptedFromListing).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not throw when the command rejects, and leaves the flag unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.vaultAdoptMailboxDirs.mockRejectedValue(new Error('disk'));
    await expect(adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING)).resolves.toBeUndefined();
    expect(settingsState.markGraphFolderKeysAdoptedFromListing).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rewrites a remembered last mailbox that was the server word', async () => {
    settingsState.lastMailboxPerAccount = { g1: 'Gesendete Elemente' };
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    expect(settingsState.setLastMailbox).toHaveBeenCalledWith('g1', 'Sent');
  });

  it('leaves a remembered last mailbox alone when the listing does not move it', async () => {
    settingsState.lastMailboxPerAccount = { g1: 'Projekte' };
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    expect(settingsState.setLastMailbox).not.toHaveBeenCalled();
  });

  it('waits for the persisted settings before reading its flag', async () => {
    settingsPersist = {
      hasHydrated: () => false,
      onFinishHydration: (cb) => {
        setTimeout(() => { settingsState.graphFolderKeysAdoptedFromListing = { g1: true }; cb(); }, 0);
        return () => {};
      },
    };
    await adoptGraphFolderKeysFromListing(GRAPH, GERMAN_LISTING);
    expect(api.vaultAdoptMailboxDirs).not.toHaveBeenCalled();
  });
});
