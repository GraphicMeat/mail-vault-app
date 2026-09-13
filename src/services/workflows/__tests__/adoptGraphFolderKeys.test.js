import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { vaultAdoptMailboxDirs: vi.fn() };
vi.mock('../../api', () => api);

let settingsState;
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => settingsState },
}));

const { adoptGraphFolderKeys, LEGACY_LOCALIZED_KEYS } = await import('../adoptGraphFolderKeys');

const GRAPH = { id: 'g1', email: 'leia@mock.test', authType: 'oauth2', oauth2Transport: 'graph' };
const IMAP = { id: 'i1', email: 'luke@mock.test', authType: 'password', imapHost: '127.0.0.1' };

beforeEach(() => {
  api.vaultAdoptMailboxDirs.mockReset().mockResolvedValue({ adopted: [], skipped_both_exist: [], failed: [] });
  settingsState = {
    graphFolderKeysAdopted: {},
    lastMailboxPerAccount: {},
    getLastMailbox: (id) => settingsState.lastMailboxPerAccount[id] || 'INBOX',
    setLastMailbox: vi.fn((id, m) => { settingsState.lastMailboxPerAccount[id] = m; }),
    markGraphFolderKeysAdopted: vi.fn((id) => { settingsState.graphFolderKeysAdopted[id] = true; }),
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
});
