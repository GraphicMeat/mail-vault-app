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
const mockSaveAccount = vi.fn().mockResolvedValue(undefined);
function accountLogicalKey(a) {
  const email = (a.email || '').toLowerCase();
  const server = (a.imapHost || a.oauth2Provider || '').toLowerCase();
  return `${email}@${server}`;
}
vi.mock('../../services/db', () => ({
  saveAccount: (...args) => mockSaveAccount(...args),
  accountLogicalKey,
  getVaultUidSets: () => Promise.resolve({ saved: new Set(), archived: new Set() }),
}));

const mockTestConnection = vi.fn().mockResolvedValue({ success: true });
const mockSmtpTestConnection = vi.fn().mockResolvedValue({ success: true });
const mockStorePassword = vi.fn().mockResolvedValue(undefined);
vi.mock('../api', () => ({
  testConnection: (...args) => mockTestConnection(...args),
  smtpTestConnection: (...args) => mockSmtpTestConnection(...args),
  storePassword: (...args) => mockStorePassword(...args),
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

describe('changeServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ success: true });
    mockSmtpTestConnection.mockResolvedValue({ success: true });
    mockStorePassword.mockResolvedValue(undefined);
    mockSaveAccount.mockResolvedValue(undefined);
    mockActivateAccount.mockResolvedValue(undefined);
    storeState = {
      accounts: [makeAccount()],
      activeAccountId: 'acc-1',
      activeMailbox: 'INBOX',
      activateAccount: mockActivateAccount,
    };
  });

  it('happy path: verifies IMAP then SMTP then persists then updates state, in order', async () => {
    const callOrder = [];
    mockTestConnection.mockImplementation(async () => { callOrder.push('imap'); return { success: true }; });
    mockSmtpTestConnection.mockImplementation(async () => { callOrder.push('smtp'); return { success: true }; });
    mockStorePassword.mockImplementation(async () => { callOrder.push('store_password'); });
    mockSaveAccount.mockImplementation(async () => { callOrder.push('saveAccount'); });

    const result = await changeServer('acc-1', NEW_PARAMS);

    expect(callOrder).toEqual(['imap', 'smtp', 'store_password', 'saveAccount']);
    expect(result).toEqual({ ok: true, hostChanged: true });

    const updated = storeState.accounts.find(a => a.id === 'acc-1');
    expect(updated.imapHost).toBe('new.host.com');
    expect(updated.password).toBe('newpass');
  });

  it('throws IMAP-prefixed error on IMAP failure and persists nothing', async () => {
    mockTestConnection.mockRejectedValue(new Error('auth failed'));

    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/^IMAP:/);

    expect(mockSmtpTestConnection).not.toHaveBeenCalled();
    expect(mockStorePassword).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });

  it('throws SMTP-prefixed error on SMTP failure and persists nothing', async () => {
    mockSmtpTestConnection.mockRejectedValue(new Error('smtp auth failed'));

    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/^SMTP:/);

    expect(mockTestConnection).toHaveBeenCalled();
    expect(mockStorePassword).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });

  it('throws on collision with another account and runs no connection tests', async () => {
    storeState.accounts.push(makeAccount({
      id: 'acc-2',
      email: 'user@example.com',
      imapHost: 'new.host.com', // same email + same target host as the change
    }));

    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/already added/);

    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockSmtpTestConnection).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });

  it('throws immediately for OAuth accounts', async () => {
    storeState.accounts = [makeAccount({ authType: 'oauth2' })];

    await expect(changeServer('acc-1', NEW_PARAMS)).rejects.toThrow(/OAuth/);

    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockSmtpTestConnection).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });

  it('hostChanged is false and no reconnect happens when only password/smtp change', async () => {
    const params = { ...NEW_PARAMS, imapHost: 'old.host.com' };

    const result = await changeServer('acc-1', params);

    expect(result).toEqual({ ok: true, hostChanged: false });
    expect(mockActivateAccount).not.toHaveBeenCalled();
  });

  it('reconnects the active account via activateAccount when the host changed', async () => {
    await changeServer('acc-1', NEW_PARAMS);

    expect(mockActivateAccount).toHaveBeenCalledWith('acc-1', 'INBOX');
  });

  it('does not reconnect when the changed account is not the active one', async () => {
    storeState.activeAccountId = 'some-other-account';

    await changeServer('acc-1', NEW_PARAMS);

    expect(mockActivateAccount).not.toHaveBeenCalled();
  });

  it('passes the new imapHost to db.saveAccount so it can stamp previousImapHost/hostChangedAt', async () => {
    await changeServer('acc-1', NEW_PARAMS);

    expect(mockSaveAccount).toHaveBeenCalledTimes(1);
    const savedCandidate = mockSaveAccount.mock.calls[0][0];
    expect(savedCandidate.imapHost).toBe('new.host.com');
    expect(savedCandidate.id).toBe('acc-1');
  });

  it('throws if the account does not exist', async () => {
    await expect(changeServer('does-not-exist', NEW_PARAMS)).rejects.toThrow(/not found/i);
  });
});

// A JMAP account stays JMAP: the session URL and the secret change, the
// daemon's imap_test_connection proves them over JMAP, and there is no SMTP
// leg to run (JMAP sends through EmailSubmission).
describe('changeServer on a JMAP account', () => {
  const JMAP = {
    id: 'acc-1', email: 'me@example.org', authType: 'password', password: 'old-token',
    imapHost: 'old.example.org', jmapSessionUrl: 'https://old.example.org/jmap/session', jmapAuth: 'bearer',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ success: true });
    mockStorePassword.mockResolvedValue(undefined);
    mockSaveAccount.mockResolvedValue(undefined);
    mockActivateAccount.mockResolvedValue(undefined);
    storeState = { accounts: [{ ...JMAP }], activeAccountId: 'acc-1', activeMailbox: 'INBOX', activateAccount: mockActivateAccount };
  });

  it('verifies the new session once, never over SMTP, and keys the account on the session host', async () => {
    const result = await changeServer('acc-1', { jmapSessionUrl: 'https://jmap.new.example.org/jmap/session', password: 'new-token' });

    expect(result).toEqual({ ok: true, hostChanged: true });
    expect(mockSmtpTestConnection).not.toHaveBeenCalled();
    expect(mockTestConnection).toHaveBeenCalledTimes(1);
    expect(mockTestConnection.mock.calls[0][0]).toMatchObject({
      id: 'acc-1', jmapSessionUrl: 'https://jmap.new.example.org/jmap/session', jmapAuth: 'bearer',
      imapHost: 'jmap.new.example.org', password: 'new-token',
    });
    expect(mockStorePassword).toHaveBeenCalledWith('acc-1', 'new-token');
    const saved = mockSaveAccount.mock.calls[0][0];
    expect(saved).toMatchObject({ id: 'acc-1', jmapSessionUrl: 'https://jmap.new.example.org/jmap/session', imapHost: 'jmap.new.example.org' });
    expect(storeState.accounts[0].imapHost).toBe('jmap.new.example.org');
    expect(mockActivateAccount).toHaveBeenCalledWith('acc-1', 'INBOX');
  });

  it('keeps the session URL when only the secret changes', async () => {
    const result = await changeServer('acc-1', { password: 'new-token' });

    expect(result).toEqual({ ok: true, hostChanged: false });
    expect(mockSaveAccount.mock.calls[0][0]).toMatchObject({ jmapSessionUrl: JMAP.jmapSessionUrl, imapHost: 'old.example.org', password: 'new-token' });
    expect(mockActivateAccount).not.toHaveBeenCalled();
  });

  it('refuses a session URL that is not https before anything is tested', async () => {
    await expect(changeServer('acc-1', { jmapSessionUrl: 'http://jmap.new.example.org/jmap', password: 'x' }))
      .rejects.toThrow('Enter the full https:// address of the JMAP session.');
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });

  it('persists nothing when the server refuses the new secret', async () => {
    mockTestConnection.mockRejectedValue(Object.assign(new Error('E_JMAP_AUTH: authentication failed'), { errorCode: 'E_JMAP_AUTH' }));

    await expect(changeServer('acc-1', { password: 'wrong' })).rejects.toThrow();
    expect(mockSmtpTestConnection).not.toHaveBeenCalled();
    expect(mockStorePassword).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });
});

describe('changeServer on a JMAP account: the Basic login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ success: true });
    storeState = {
      accounts: [{ id: 'acc-1', email: 'me@example.org', authType: 'password', password: 'p', imapHost: 'mail.example.org',
        jmapSessionUrl: 'https://mail.example.org/jmap/session', jmapAuth: 'basic', jmapUsername: 'old-login' }],
      activeAccountId: 'acc-1', activeMailbox: 'INBOX', activateAccount: mockActivateAccount,
    };
  });

  it('stores a new login, and drops it when it is the address again', async () => {
    await changeServer('acc-1', { jmapUsername: ' alice ', password: 'p2' });
    expect(mockSaveAccount.mock.calls[0][0].jmapUsername).toBe('alice');

    await changeServer('acc-1', { jmapUsername: 'me@example.org', password: 'p3' });
    expect(mockSaveAccount.mock.calls[1][0]).not.toHaveProperty('jmapUsername');
  });
});
