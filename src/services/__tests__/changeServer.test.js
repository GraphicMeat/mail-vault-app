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
  getSavedEmailIds: () => Promise.resolve(new Set()),
  getArchivedEmailIds: () => Promise.resolve(new Set()),
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
  setGraphIdMap: () => {},
  getGraphMessageId: () => null,
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
