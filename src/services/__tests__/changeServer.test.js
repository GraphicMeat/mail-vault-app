import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub browser globals accessed at module level by transport.js/db.js et al.
if (!globalThis.window) {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

// ── Mock the same dependency surface as mailStore.test.js — activateAccount.js
// pulls in the same transitive tree via accountSlice.js. ──
const mockPatchAccount = vi.fn().mockResolvedValue(undefined);
const mockUpdateAccountNative = vi.fn();
function accountLogicalKey(a) {
  const email = (a.email || '').toLowerCase();
  const server = (a.imapHost || a.oauth2Provider || '').toLowerCase();
  return `${email}@${server}`;
}
vi.mock('../../services/db', () => ({
  updateAccountNative: (...args) => mockUpdateAccountNative(...args),
  patchAccount: async (id, fields, options) => {
    await mockPatchAccount(id, fields, options);
    const old = storeState.accounts.find(a => a.id === id);
    const account = { ...old, ...fields, id };
    for (const k of ['password', 'oauth2AccessToken', 'oauth2RefreshToken', ...(options.unset || [])]) delete account[k];
    return { account, hostChanged: !!old.imapHost && !!fields.imapHost && old.imapHost !== fields.imapHost };
  },
  accountExpectedContext: a => ({ fields: { email: a.email, imapHost: a.imapHost } }),
  accountLogicalKey,
  getVaultUidSets: () => Promise.resolve({ saved: new Set(), archived: new Set() }),
}));

const mockTestConnection = vi.fn().mockResolvedValue({ success: true });
const mockSmtpTestConnection = vi.fn().mockResolvedValue({ success: true });
vi.mock('../api', () => ({
  testConnection: (...args) => mockTestConnection(...args),
  smtpTestConnection: (...args) => mockSmtpTestConnection(...args),
}));

vi.mock('../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../attachmentUtils', () => ({
  hasRealAttachments: () => false,
}));
vi.mock('../../utils/emailParser', () => ({
  buildThreads: () => new Map(),
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
    }),
  },
  hasPremiumAccess: () => false,
}));
vi.mock('../safeStorage', () => ({
  safeStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}));
vi.mock('../cacheManager', () => ({
  getRestoreDescriptor: () => null,
  saveRestoreDescriptor: () => {},
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
  restoreGraphIdMap: () => {},
}));

// ── Fake Zustand-style mail store ──
const mockActivateAccount = vi.fn().mockResolvedValue(undefined);
let storeState;

function makeAccount(overrides = {}) {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    authType: 'password',
    imapHost: 'old.host.com',
    imapPort: 993,
    smtpHost: 'old-smtp.host.com',
    smtpPort: 465,
    password: 'oldpass',
    ...overrides,
  };
}

vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => storeState,
    setState: (updater) => {
      const patch = typeof updater === 'function' ? updater(storeState) : updater;
      storeState = { ...storeState, ...patch };
    },
    subscribe: () => () => {},
  },
}));

const { changeServer } = await import('../workflows/changeServer');

const NEW_PARAMS = {
  imapHost: 'new.host.com',
  imapPort: 993,
  smtpHost: 'new-smtp.host.com',
  smtpPort: 465,
  password: 'newpass',
};

function nativeReply(id, fields, { unset = [] } = {}) {
  const old = storeState.accounts.find(a => a.id === id);
  const account = { ...old, ...fields, id };
  for (const key of ['password', 'oauth2AccessToken', 'oauth2RefreshToken', ...unset]) delete account[key];
  const hostChanged = !!old.imapHost && !!fields.imapHost && old.imapHost !== fields.imapHost;
  if (hostChanged) {
    account.previousImapHost = old.imapHost;
    account.hostChangedAt = 123456789;
  }
  return { account, hostChanged };
}

function expectNoLegacyCalls() {
  expect(mockPatchAccount).not.toHaveBeenCalled();
  expect(mockTestConnection).not.toHaveBeenCalled();
  expect(mockSmtpTestConnection).not.toHaveBeenCalled();
}

function resetMocks() {
  vi.clearAllMocks();
  mockUpdateAccountNative.mockImplementation(nativeReply);
  mockTestConnection.mockRejectedValue(new Error('renderer IMAP probe must not run'));
  mockSmtpTestConnection.mockRejectedValue(new Error('renderer SMTP probe must not run'));
  mockActivateAccount.mockResolvedValue(undefined);
}

const nativeProbeFailure = (host, port, errorCode = 'auth') => Object.assign(
  new Error('errors.conn.couldReachMailServerCheck'), { errorCode, host, port },
);

describe('changeServer on a password/IMAP account', () => {
  beforeEach(() => {
    resetMocks();
    storeState = {
      accounts: [makeAccount()], activeAccountId: 'acc-1', activeMailbox: 'INBOX',
      activateAccount: mockActivateAccount,
    };
  });

  it('persists through one native update without the retired password writer', async () => {
    mockUpdateAccountNative.mockResolvedValue({
      account: { ...makeAccount(NEW_PARAMS), password: undefined }, hostChanged: true,
    });
    let result;
    let error;
    try { result = await changeServer('acc-1', NEW_PARAMS); }
    catch (caught) { error = caught; }
    const observed = `S25_CHANGE_SERVER_NATIVE_ACTUAL: resolved=${!!result}, nativeCalls=${mockUpdateAccountNative.mock.calls.length}, patchCalls=${mockPatchAccount.mock.calls.length}, stateHost=${storeState.accounts[0].imapHost}, error=${error?.message || 'none'}`;
    console.log(observed);
    expect(result, observed).toEqual({ ok: true, hostChanged: true });
    expect(mockUpdateAccountNative).toHaveBeenCalledOnce();
    expect(mockUpdateAccountNative.mock.calls[0]).toMatchObject(['acc-1', {
      imapHost: 'new.host.com', imapPort: 993, imapSecurity: 'ssl',
      smtpHost: 'new-smtp.host.com', smtpPort: 465, password: 'newpass',
    }, { expected: { fields: { email: 'user@example.com', imapHost: 'old.host.com' } } }]);
    expectNoLegacyCalls();
    expect(storeState.accounts[0].imapHost).toBe('new.host.com');
    expect(storeState.accounts[0].password).toBe('newpass');
  });

  it('submits all six server fields and applies confirmed previous-host metadata', async () => {
    const result = await changeServer('acc-1', NEW_PARAMS);
    expect(result).toEqual({ ok: true, hostChanged: true });
    expect(mockUpdateAccountNative).toHaveBeenCalledOnce();
    expect(mockUpdateAccountNative.mock.calls[0][1]).toMatchObject({
      imapHost: 'new.host.com', imapPort: 993, imapSecurity: 'ssl',
      smtpHost: 'new-smtp.host.com', smtpPort: 465, password: 'newpass',
    });
    expect(storeState.accounts[0]).toMatchObject({
      previousImapHost: 'old.host.com', hostChangedAt: 123456789, imapHost: 'new.host.com',
    });
    expect(mockActivateAccount).toHaveBeenCalledWith('acc-1', 'INBOX');
    expectNoLegacyCalls();
  });

  it('keeps the old account and secret when the native IMAP probe fails', async () => {
    mockUpdateAccountNative.mockRejectedValue(nativeProbeFailure('new.host.com', 993));
    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/^IMAP:/);
    expect(storeState.accounts[0]).toEqual(makeAccount());
    expect(mockActivateAccount).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('keeps the old account and secret when the native SMTP probe fails', async () => {
    mockUpdateAccountNative.mockRejectedValue(nativeProbeFailure('new-smtp.host.com', 465, 'refused'));
    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/^SMTP:/);
    expect(storeState.accounts[0]).toEqual(makeAccount());
    expect(mockActivateAccount).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('leaves the visible account unchanged on a stale or retired native refusal', async () => {
    mockUpdateAccountNative.mockRejectedValue(new Error('errors.accountsConflict'));
    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow('errors.accountsConflict');
    expect(storeState.accounts[0]).toEqual(makeAccount());
    expect(mockActivateAccount).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('refuses a local logical-key collision before any native request', async () => {
    storeState.accounts.push(makeAccount({
      id: 'acc-2', email: 'user@example.com', imapHost: 'new.host.com',
    }));
    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/already added/);
    expect(mockUpdateAccountNative).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('refuses an OAuth account before any native request', async () => {
    storeState.accounts = [makeAccount({ authType: 'oauth2' })];
    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/OAuth/);
    expect(mockUpdateAccountNative).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('does not reconnect when the confirmed IMAP host is unchanged', async () => {
    const result = await changeServer('acc-1', { ...NEW_PARAMS, imapHost: 'old.host.com' });
    expect(result).toEqual({ ok: true, hostChanged: false });
    expect(mockActivateAccount).not.toHaveBeenCalled();
  });

  it('does not reconnect when the changed account is not active', async () => {
    storeState.activeAccountId = 'another';
    await changeServer('acc-1', NEW_PARAMS);
    expect(mockActivateAccount).not.toHaveBeenCalled();
  });

  it('reports a completed native save even if reactivation fails', async () => {
    mockActivateAccount.mockRejectedValue(new Error('offline'));
    const result = await changeServer('acc-1', NEW_PARAMS);
    expect(result).toEqual({ ok: true, hostChanged: true });
    expect(storeState.accounts[0].imapHost).toBe('new.host.com');
  });

  it('rejects a missing account before any native request', async () => {
    await expect(changeServer('missing', NEW_PARAMS)).rejects.toThrow(/not found/i);
    expect(mockUpdateAccountNative).not.toHaveBeenCalled();
  });
});

describe('changeServer on a JMAP account', () => {
  const JMAP = {
    id: 'acc-1', email: 'me@example.org', authType: 'password', password: 'old-token',
    imapHost: 'old.example.org', jmapSessionUrl: 'https://old.example.org/jmap/session', jmapAuth: 'bearer',
  };

  beforeEach(() => {
    resetMocks();
    storeState = {
      accounts: [{ ...JMAP }], activeAccountId: 'acc-1', activeMailbox: 'INBOX',
      activateAccount: mockActivateAccount,
    };
  });

  it('persists a JMAP session through native update without the retired writer', async () => {
    mockUpdateAccountNative.mockResolvedValue({ account: {
      ...JMAP, jmapSessionUrl: 'https://jmap.new.example.org/jmap/session',
      imapHost: 'jmap.new.example.org', password: undefined,
    }, hostChanged: true });
    let result;
    let error;
    try {
      result = await changeServer('acc-1', { jmapSessionUrl: 'https://jmap.new.example.org/jmap/session', password: 'new-token' });
    } catch (caught) { error = caught; }
    const observed = `S25_CHANGE_SERVER_JMAP_ACTUAL: resolved=${!!result}, nativeCalls=${mockUpdateAccountNative.mock.calls.length}, patchCalls=${mockPatchAccount.mock.calls.length}, stateUrl=${storeState.accounts[0].jmapSessionUrl}, error=${error?.message || 'none'}`;
    console.log(observed);
    expect(result, observed).toEqual({ ok: true, hostChanged: true });
    expect(mockUpdateAccountNative).toHaveBeenCalledOnce();
    expect(mockUpdateAccountNative.mock.calls[0]).toMatchObject(['acc-1', {
      jmapSessionUrl: 'https://jmap.new.example.org/jmap/session', imapHost: 'jmap.new.example.org',
      password: 'new-token',
    }, { expected: { fields: { email: 'me@example.org', imapHost: 'old.example.org' } } }]);
    expectNoLegacyCalls();
    expect(storeState.accounts[0].jmapSessionUrl).toBe('https://jmap.new.example.org/jmap/session');
  });

  it('uses one native JMAP probe path and keeps the account on JMAP', async () => {
    const result = await changeServer('acc-1', {
      jmapSessionUrl: 'https://jmap.new.example.org/jmap/session', password: 'new-token',
    });
    expect(result).toEqual({ ok: true, hostChanged: true });
    expect(mockUpdateAccountNative.mock.calls[0][1]).toMatchObject({
      jmapSessionUrl: 'https://jmap.new.example.org/jmap/session',
      imapHost: 'jmap.new.example.org', password: 'new-token',
    });
    expect(storeState.accounts[0]).toMatchObject({
      jmapAuth: 'bearer', imapHost: 'jmap.new.example.org', password: 'new-token',
    });
    expect(mockActivateAccount).toHaveBeenCalledWith('acc-1', 'INBOX');
    expectNoLegacyCalls();
  });

  it('reactivates when a JMAP session URL changes within the same host', async () => {
    const result = await changeServer('acc-1', {
      jmapSessionUrl: 'https://old.example.org/jmap/other', password: 'new-token',
    });
    expect(result).toEqual({ ok: true, hostChanged: true });
    expect(mockActivateAccount).toHaveBeenCalledWith('acc-1', 'INBOX');
  });

  it('keeps the session URL and skips reconnect when only the secret changes', async () => {
    const result = await changeServer('acc-1', { password: 'new-token' });
    expect(result).toEqual({ ok: true, hostChanged: false });
    expect(mockUpdateAccountNative.mock.calls[0][1]).toMatchObject({
      jmapSessionUrl: JMAP.jmapSessionUrl, imapHost: 'old.example.org', password: 'new-token',
    });
    expect(mockActivateAccount).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS session URL before any native request', async () => {
    await expect(changeServer('acc-1', {
      jmapSessionUrl: 'http://jmap.new.example.org/jmap', password: 'x',
    })).rejects.toThrow('Enter the full https:// address of the JMAP session.');
    expect(mockUpdateAccountNative).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('leaves the old session and secret on a native JMAP probe refusal', async () => {
    mockUpdateAccountNative.mockRejectedValue(nativeProbeFailure('old.example.org', 443, 'E_JMAP_AUTH'));
    await expect(changeServer('acc-1', { password: 'wrong' })).rejects.toThrow();
    expect(storeState.accounts[0]).toEqual(JMAP);
    expect(mockActivateAccount).not.toHaveBeenCalled();
    expectNoLegacyCalls();
  });

  it('sets a distinct Basic login and unsets it when the address is selected', async () => {
    storeState.accounts[0] = { ...JMAP, jmapAuth: 'basic', jmapUsername: 'old-login' };
    await changeServer('acc-1', { jmapUsername: ' alice ', password: 'p2' });
    expect(mockUpdateAccountNative.mock.calls[0][1].jmapUsername).toBe('alice');
    expect(mockUpdateAccountNative.mock.calls[0][2].unset).toEqual([]);
    await changeServer('acc-1', { jmapUsername: 'me@example.org', password: 'p3' });
    expect(mockUpdateAccountNative.mock.calls[1][1]).not.toHaveProperty('jmapUsername');
    expect(mockUpdateAccountNative.mock.calls[1][2].unset).toEqual(['jmapUsername']);
    expect(storeState.accounts[0]).not.toHaveProperty('jmapUsername');
    expectNoLegacyCalls();
  });
});
