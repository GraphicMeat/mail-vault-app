// The keychain trap saveAccounts exists for: after a denied/cancelled read,
// loadKeychain() hands back {}, so writing then would replace every other
// account's secrets. saveAccounts must refuse before any write. The
// credentials go out as ONE per-record change (db/keychain.js), the
// metadata as ONE accounts.put the daemon merges into accounts.json.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeAccountsDaemon } from '../../db/__tests__/fakeAccountsDaemon.js';

const h = vi.hoisted(() => ({ status: 'granted', cache: {}, file: null }));
const mockLoadKeychain = vi.fn(async () => h.cache);
const mockSaveCredentials = vi.fn(async () => {});

vi.mock('../../db/keychain.js', () => ({
  parseKeychainValue: (id, v) => JSON.parse(v),
  getAccountsFromKeychain: () => [],
  loadKeychain: (...a) => mockLoadKeychain(...a),
  saveCredentials: (...a) => mockSaveCredentials(...a),
  deleteCredentials: vi.fn(async () => {}),
  updateCredentials: vi.fn(async () => true),
}));
vi.mock('../../keychainSession.js', () => ({ getStatus: () => h.status, E_KEYCHAIN_UNAVAILABLE: 'E_KEYCHAIN_UNAVAILABLE', E_KEYCHAIN_WRITE: 'E_KEYCHAIN_WRITE' }));
const daemon = fakeAccountsDaemon({ read: () => h.file, write: (text) => { h.file = text; } });
const mockAccountsCall = vi.fn((cmd, args) => daemon.call(cmd, args));
vi.mock('../../transport.js', () => ({
  send: vi.fn(async (cmd, args) => {
    if (cmd.startsWith('accounts.')) return mockAccountsCall(cmd, args);
    return cmd === 'get_app_data_dir' ? '/mock/appdata' : {};
  }),
}));
vi.mock('../../graphConfig.js', () => ({ isPersonalMicrosoftEmail: () => false }));
vi.mock('../../../i18n/index.js', () => ({ t: (k) => k }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  BaseDirectory: { AppData: 1 },
}));

const { saveAccounts } = await import('../../db/accounts.js');

const incoming = [
  { id: 'a', email: 'a@x.test', password: 'pa' },
  { id: 'b', email: 'b@x.test', authType: 'oauth2', oauth2AccessToken: 'at', oauth2RefreshToken: 'rt' },
];
const puts = () => mockAccountsCall.mock.calls.filter(([cmd]) => cmd === 'accounts.put');

beforeEach(() => {
  h.file = JSON.stringify([{ id: 'old', email: 'old@x.test' }]);
  mockSaveCredentials.mockReset();
  mockSaveCredentials.mockImplementation(async () => {});
  mockAccountsCall.mockClear();
  mockLoadKeychain.mockReset();
  mockLoadKeychain.mockImplementation(async () => h.cache);
});

describe('saveAccounts', () => {
  for (const status of ['denied', 'cancelled', 'timed_out', 'unavailable']) {
    it(`refuses with E_KEYCHAIN_UNAVAILABLE and writes nothing when the read was ${status}`, async () => {
      h.status = status;
      h.cache = {};
      await expect(saveAccounts(incoming)).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');
      expect(mockSaveCredentials).not.toHaveBeenCalled();
      expect(puts()).toHaveLength(0);
    });
  }

  it('saves every record in ONE change and puts the secret-free metadata in ONE write', async () => {
    h.status = 'granted';
    h.cache = { old: JSON.stringify({ id: 'old', email: 'old@x.test', password: 'keep' }) };
    await saveAccounts(incoming);

    expect(mockSaveCredentials).toHaveBeenCalledTimes(1);
    const records = mockSaveCredentials.mock.calls[0][0];
    expect(Object.keys(records).sort()).toEqual(['a', 'b']); // only the new ones: the daemon keeps `old`
    expect(JSON.parse(records.b).oauth2RefreshToken).toBe('rt');

    expect(puts()).toHaveLength(1);
    expect(JSON.stringify(puts()[0][1])).not.toMatch(/password|oauth2AccessToken|oauth2RefreshToken/);
    expect(JSON.parse(h.file).map(a => a.id)).toEqual(['old', 'a', 'b']);
    expect(h.file).not.toMatch(/password|oauth2AccessToken|oauth2RefreshToken/);
  });

  // A transferred Google account keeps refreshing with the client that issued
  // its token: the stamp travels in the same keychain record as the token.
  it('keeps oauth2ClientId in the keychain record next to the refresh token', async () => {
    h.status = 'granted';
    h.cache = {};
    await saveAccounts([{ ...incoming[1], oauth2ClientId: 'own.apps.googleusercontent.com' }]);
    const record = JSON.parse(mockSaveCredentials.mock.calls[0][0].b);
    expect(record.oauth2RefreshToken).toBe('rt');
    expect(record.oauth2ClientId).toBe('own.apps.googleusercontent.com');
  });

  it('accepts an empty keychain (fresh machine)', async () => {
    h.status = 'empty';
    h.cache = {};
    await saveAccounts(incoming);
    expect(Object.keys(mockSaveCredentials.mock.calls[0][0]).sort()).toEqual(['a', 'b']);
  });

  it('reads the keychain status only AFTER loadKeychain resolves (the read is what sets it)', async () => {
    h.status = 'idle';
    h.cache = {};
    mockLoadKeychain.mockImplementation(async () => { h.status = 'granted'; return h.cache; });
    await saveAccounts(incoming);
    expect(mockSaveCredentials).toHaveBeenCalledTimes(1);
  });

  it('wraps a failed keychain write as E_KEYCHAIN_WRITE and writes no metadata', async () => {
    h.status = 'granted';
    h.cache = {};
    mockSaveCredentials.mockRejectedValueOnce('Failed to store credentials: errSecInteractionNotAllowed');
    await expect(saveAccounts(incoming)).rejects.toThrow(/^E_KEYCHAIN_WRITE: Failed to store credentials/);
    expect(puts()).toHaveLength(0);
  });

  it('keeps the E_ code a refusal already carries', async () => {
    h.status = 'granted';
    mockSaveCredentials.mockRejectedValueOnce(new Error('E_KEYCHAIN_UNAVAILABLE'));
    await expect(saveAccounts(incoming)).rejects.toThrow(/^E_KEYCHAIN_UNAVAILABLE$/);
  });

  it('wraps a failed accounts.json write as E_KEYCHAIN_WRITE', async () => {
    h.status = 'granted';
    h.cache = {};
    mockAccountsCall.mockImplementationOnce(() => { throw new Error('errors.accountsWriteFailed'); });
    await expect(saveAccounts(incoming)).rejects.toThrow(/^E_KEYCHAIN_WRITE: errors\.accountsWriteFailed$/);
  });
});
