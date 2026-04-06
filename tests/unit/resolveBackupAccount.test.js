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

// Mock api
vi.mock('../../src/services/api', () => ({
  refreshOAuth2Token: vi.fn().mockResolvedValue({
    accessToken: 'new-header.new-payload.new-signature',
    refreshToken: 'new-ref',
    expiresAt: Date.now() + 3600_000,
  }),
}));

const { resolveServerAccount, resolveBackupAccount, hasValidCredentials, hasUsableGraphToken } = await import('../../src/services/authUtils');
const apiMod = await import('../../src/services/api');

const EXPECTED_ERROR = 'Credentials unavailable — retry keychain access or re-enter in Settings > Accounts';

// ── hasUsableGraphToken ─────────────────────────────────────────────────

describe('hasUsableGraphToken', () => {
  it('accepts JWT-shaped tokens', () => {
    expect(hasUsableGraphToken({ oauth2Transport: 'graph', oauth2AccessToken: 'aaa.bbb.ccc' })).toBe(true);
  });
  it('rejects tokens with zero dots', () => {
    expect(hasUsableGraphToken({ oauth2Transport: 'graph', oauth2AccessToken: 'plaintoken' })).toBe(false);
  });
  it('rejects tokens with one dot', () => {
    expect(hasUsableGraphToken({ oauth2Transport: 'graph', oauth2AccessToken: 'part1.part2' })).toBe(false);
  });
  it('rejects empty/null tokens', () => {
    expect(hasUsableGraphToken({ oauth2Transport: 'graph', oauth2AccessToken: '' })).toBe(false);
    expect(hasUsableGraphToken({ oauth2Transport: 'graph', oauth2AccessToken: null })).toBe(false);
  });
  it('rejects non-graph accounts', () => {
    expect(hasUsableGraphToken({ oauth2Transport: 'imap', oauth2AccessToken: 'aaa.bbb.ccc' })).toBe(false);
  });
});

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

// ── resolveBackupAccount ────────────────────────────────────────────────

describe('resolveBackupAccount', () => {
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

  it('recovers Graph account from keychain with malformed token + refresh token', async () => {
    // Store has metadata only (no token at all)
    const fileOnlyGraph = { id: 'acc-graph', email: 'vader@outlook.com', authType: 'oauth2', oauth2Transport: 'graph' };
    // Keychain has malformed access token but valid refresh token
    mockGetAccount.mockResolvedValueOnce({
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'not-a-jwt',
      oauth2RefreshToken: 'valid-refresh-token', oauth2ExpiresAt: Date.now() + 3600_000,
      oauth2Transport: 'graph',
    });
    const result = await resolveServerAccount('acc-graph', fileOnlyGraph);
    // Should have adopted keychain account (recoverable) and force-refreshed
    expect(apiMod.refreshOAuth2Token).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.source).toBe('refreshed');
  });

  it('force-refreshes Graph account with malformed token even if not expired', async () => {
    const malformedGraph = {
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'not-a-jwt',
      oauth2RefreshToken: 'ref123', oauth2ExpiresAt: Date.now() + 3600_000,
      oauth2Transport: 'graph',
    };
    // Keychain also has malformed token
    mockGetAccount.mockResolvedValueOnce({ ...malformedGraph });
    const result = await resolveServerAccount('acc-graph', malformedGraph);
    // Should have called refresh
    expect(apiMod.refreshOAuth2Token).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.source).toBe('refreshed');
  });

  it('attempts force-refresh for Graph non-JWT token but passes through if refresh also returns non-JWT', async () => {
    const malformedGraph = {
      id: 'acc-graph', email: 'vader@outlook.com',
      authType: 'oauth2', oauth2AccessToken: 'not-a-jwt',
      oauth2RefreshToken: 'ref123', oauth2ExpiresAt: Date.now() + 3600_000,
      oauth2Transport: 'graph',
    };
    // Refresh returns a non-JWT token (Microsoft opaque tokens are valid)
    apiMod.refreshOAuth2Token.mockResolvedValueOnce({
      accessToken: 'still-not-jwt',
      refreshToken: 'ref2',
      expiresAt: Date.now() + 3600_000,
    });
    const result = await resolveServerAccount('acc-graph', malformedGraph);
    // Force refresh was attempted
    expect(apiMod.refreshOAuth2Token).toHaveBeenCalled();
    // Still ok — non-JWT token is accepted (Rust/Graph decides if it's valid)
    expect(result.ok).toBe(true);
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

  it('resolveBackupAccount is an alias for resolveServerAccount', () => {
    expect(resolveBackupAccount).toBe(resolveServerAccount);
  });
});
