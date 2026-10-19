import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module
const mockGetAccount = vi.fn();
vi.mock('../../src/services/db', () => ({
  getAccount: (...args) => mockGetAccount(...args),
  updateOAuth2Tokens: vi.fn(),
}));

// Mock mailStore
const mockAccounts = [
  { id: 'acc-1', email: 'luke@test.com', password: 'pass1' },
  { id: 'acc-graph', email: 'vader@outlook.com', authType: 'oauth2', oauth2AccessToken: 'header.payload.signature', oauth2RefreshToken: 'ref123', oauth2ExpiresAt: Date.now() + 3600_000, oauth2Transport: 'graph' },
];
vi.mock('../../src/stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ accounts: [...mockAccounts] }),
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));

// The app never refreshes a token any more (the daemon does): any call here
// would be a regression.
const refreshCall = vi.fn();
vi.mock('../../src/services/api', () => ({ refreshOAuth2Token: (...args) => refreshCall(...args) }));
vi.mock('../../src/services/transport.js', () => ({ send: (...args) => refreshCall(...args) }));

const authUtils = await import('../../src/services/authUtils');
const { resolveServerAccount, hasValidCredentials } = authUtils;

const EXPECTED_ERROR = 'Credentials unavailable: retry keychain access or re-enter in Settings > Accounts';

// ── hasValidCredentials (transport-aware) ────────────────────────────────

describe('hasValidCredentials — presence check', () => {
  it('accepts password accounts', () => {
    expect(hasValidCredentials({ password: 'pass' })).toBe(true);
  });
  it('accepts OAuth2 with any non-empty token', () => {
    expect(hasValidCredentials({ authType: 'oauth2', oauth2AccessToken: 'plaintoken' })).toBe(true);
  });
  it('accepts Graph accounts with any non-empty token (not JWT-gated)', () => {
    expect(hasValidCredentials({ authType: 'oauth2', oauth2Transport: 'graph', oauth2AccessToken: 'opaque-token' })).toBe(true);
  });
  it('rejects accounts with no password and no token', () => {
    expect(hasValidCredentials({ authType: 'oauth2' })).toBe(false);
    expect(hasValidCredentials({ authType: 'oauth2', oauth2AccessToken: '' })).toBe(false);
  });
});

// ── resolveServerAccount ────────────────────────────────────────────────

describe('resolveServerAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue(null); // default: keychain returns nothing
  });

  it('returns ok:true with source:store when store has credentials', async () => {
    const result = await resolveServerAccount('acc-1', { id: 'acc-1', email: 'luke@test.com', password: 'pass1' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('store');
    expect(result.account.password).toBe('pass1');
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('fetches from keychain with source:keychain when store lacks credentials', async () => {
    mockGetAccount.mockResolvedValueOnce({ id: 'acc-1', email: 'luke@test.com', password: 'fromKeychain' });
    const result = await resolveServerAccount('acc-1', { id: 'acc-1', email: 'luke@test.com' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('keychain');
    expect(result.account.password).toBe('fromKeychain');
  });

  it('returns ok:false reason:missing_credentials when both store and keychain lack credentials', async () => {
    mockGetAccount.mockResolvedValueOnce({ id: 'acc-1', email: 'luke@test.com' });
    const result = await resolveServerAccount('acc-1', { id: 'acc-1', email: 'luke@test.com' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('keychain_account_missing');
    expect(result.message).toBe(EXPECTED_ERROR);
  });

  it('returns ok:true for Graph account with JWT token in store', async () => {
    const graphAccount = {
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'header.payload.signature',
      oauth2RefreshToken: 'ref123', oauth2ExpiresAt: Date.now() + 3600_000,
      oauth2Transport: 'graph',
    };
    const result = await resolveServerAccount('acc-graph', graphAccount);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('store');
  });

  it('adopts a keychain OAuth2 account that has a refresh token, without refreshing it', async () => {
    const fileOnlyGraph = { id: 'acc-graph', email: 'vader@outlook.com', authType: 'oauth2', oauth2Transport: 'graph' };
    mockGetAccount.mockResolvedValueOnce({
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'not-a-jwt',
      oauth2RefreshToken: 'valid-refresh-token', oauth2ExpiresAt: Date.now() - 1000,
      oauth2Transport: 'graph',
    });
    const result = await resolveServerAccount('acc-graph', fileOnlyGraph);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('keychain');
    expect(result.account.oauth2AccessToken).toBe('not-a-jwt');
    expect(refreshCall).not.toHaveBeenCalled();
  });

  it('passes an OAuth2 account with a refresh token and no access token: the daemon renews it', async () => {
    const noAccess = { id: 'acc-graph', email: 'vader@outlook.com', authType: 'oauth2', oauth2RefreshToken: 'ref123', oauth2Transport: 'graph' };
    mockGetAccount.mockResolvedValueOnce({ ...noAccess });
    const result = await resolveServerAccount('acc-graph', noAccess);
    expect(result.ok).toBe(true);
    expect(refreshCall).not.toHaveBeenCalled();
  });

  it('leaves an expired token as it is: refreshing is the daemon\'s job', async () => {
    const expired = {
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'old.expired.token',
      oauth2RefreshToken: 'ref123', oauth2ExpiresAt: Date.now() - 1000,
      oauth2Transport: 'graph',
    };
    const result = await resolveServerAccount('acc-graph', expired);
    expect(result).toMatchObject({ ok: true, source: 'store' });
    expect(result.account.oauth2AccessToken).toBe('old.expired.token');
    expect(refreshCall).not.toHaveBeenCalled();
  });

  it('passes through Graph account with non-JWT token and no refresh token', async () => {
    const noRefresh = {
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'opaque-token',
      oauth2Transport: 'graph',
    };
    const result = await resolveServerAccount('acc-graph', noRefresh);
    // Non-JWT token is accepted — hasValidCredentials checks presence, not shape
    expect(result.ok).toBe(true);
  });

  it('returns error with standard message when no credentials exist', async () => {
    // Account with no password, no authType, no token — truly empty
    mockGetAccount.mockResolvedValueOnce(null);
    const r1 = await resolveServerAccount('no-creds', { id: 'no-creds', email: 'empty@test.com' });
    expect(r1.ok).toBe(false);
    expect(r1.message).toBe(EXPECTED_ERROR);
  });

  it('exports nothing that refreshes', () => {
    expect(authUtils.ensureFreshToken).toBeUndefined();
    expect(authUtils.resolveBackupAccount).toBeUndefined();
    expect(authUtils.hasUsableGraphToken).toBeUndefined();
  });
});
