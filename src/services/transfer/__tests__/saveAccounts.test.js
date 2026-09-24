// The keychain trap saveAccounts exists for: after a denied/cancelled read,
// loadKeychain() hands back {} and saveKeychain's merge guard only protects a
// non-empty cache, so writing then would replace every other account's
// secrets. saveAccounts must refuse before any write.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ status: 'granted', cache: {} }));
const mockLoadKeychain = vi.fn(async () => h.cache);
const mockSaveKeychain = vi.fn(async () => {});
const mockWriteTextFile = vi.fn(async () => {});

vi.mock('../../db/keychain.js', () => ({
  parseKeychainValue: (id, v) => JSON.parse(v),
  getAccountsFromKeychain: () => [],
  loadKeychain: (...a) => mockLoadKeychain(...a),
  saveKeychain: (...a) => mockSaveKeychain(...a),
}));
vi.mock('../../keychainSession.js', () => ({ getStatus: () => h.status, E_KEYCHAIN_UNAVAILABLE: 'E_KEYCHAIN_UNAVAILABLE', E_KEYCHAIN_WRITE: 'E_KEYCHAIN_WRITE' }));
// dataPath() (src/services/db/accounts.js) resolves the app data dir via
// invoke('get_app_data_dir') before any read/write; every other command this
// test can reach stays a no-op {}.
vi.mock('../../transport.js', () => ({
  send: vi.fn(async (cmd) => (cmd === 'get_app_data_dir' ? '/mock/appdata' : {})),
}));
vi.mock('../../graphConfig.js', () => ({ isPersonalMicrosoftEmail: () => false }));
vi.mock('../../../i18n/index.js', () => ({ t: (k) => k }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  readTextFile: vi.fn(async () => JSON.stringify([{ id: 'old', email: 'old@x.test' }])),
  writeTextFile: (...a) => mockWriteTextFile(...a),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  BaseDirectory: { AppData: 1 },
}));

const { saveAccounts } = await import('../../db/accounts.js');

const incoming = [
  { id: 'a', email: 'a@x.test', password: 'pa' },
  { id: 'b', email: 'b@x.test', authType: 'oauth2', oauth2AccessToken: 'at', oauth2RefreshToken: 'rt' },
];

beforeEach(() => {
  mockSaveKeychain.mockReset();
  mockSaveKeychain.mockImplementation(async () => {});
  mockWriteTextFile.mockReset();
  mockWriteTextFile.mockImplementation(async () => {});
  mockLoadKeychain.mockReset();
  mockLoadKeychain.mockImplementation(async () => h.cache);
});

describe('saveAccounts', () => {
  for (const status of ['denied', 'cancelled', 'timed_out', 'unavailable']) {
    it(`refuses with E_KEYCHAIN_UNAVAILABLE and writes nothing when the read was ${status}`, async () => {
      h.status = status;
      h.cache = {};
      await expect(saveAccounts(incoming)).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');
      expect(mockSaveKeychain).not.toHaveBeenCalled();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });
  }

  it('merges into the existing keychain in ONE write and strips secrets from accounts.json', async () => {
    h.status = 'granted';
    h.cache = { old: JSON.stringify({ id: 'old', email: 'old@x.test', password: 'keep' }) };
    await saveAccounts(incoming);

    expect(mockSaveKeychain).toHaveBeenCalledTimes(1);
    const written = mockSaveKeychain.mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual(['a', 'b', 'old']);
    expect(JSON.parse(written.old).password).toBe('keep');
    expect(JSON.parse(written.b).oauth2RefreshToken).toBe('rt');

    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    const file = mockWriteTextFile.mock.calls[0][1];
    expect(JSON.parse(file).map(a => a.id)).toEqual(['old', 'a', 'b']);
    expect(file).not.toMatch(/password|oauth2AccessToken|oauth2RefreshToken/);
  });

  it('accepts an empty keychain (fresh machine)', async () => {
    h.status = 'empty';
    h.cache = {};
    await saveAccounts(incoming);
    expect(Object.keys(mockSaveKeychain.mock.calls[0][0]).sort()).toEqual(['a', 'b']);
  });

  it('reads the keychain status only AFTER loadKeychain resolves (the read is what sets it)', async () => {
    h.status = 'idle';
    h.cache = {};
    mockLoadKeychain.mockImplementation(async () => { h.status = 'granted'; return h.cache; });
    await saveAccounts(incoming);
    expect(mockLoadKeychain).toHaveBeenCalledTimes(1); // initDB already ran: this is saveAccounts' own read
    expect(mockSaveKeychain).toHaveBeenCalledTimes(1);
  });

  it('wraps a failed keychain write as E_KEYCHAIN_WRITE and takes its accounts back out of the shared cache', async () => {
    h.status = 'granted';
    const before = { old: JSON.stringify({ id: 'old', email: 'old@x.test', password: 'keep' }) };
    h.cache = { ...before };
    mockSaveKeychain.mockRejectedValueOnce('Failed to store credentials: errSecInteractionNotAllowed');

    await expect(saveAccounts(incoming)).rejects.toThrow(/^E_KEYCHAIN_WRITE: Failed to store credentials/);
    expect(h.cache).toEqual(before); // a later token-refresh write cannot persist a or b
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('wraps a failed accounts.json write as E_KEYCHAIN_WRITE', async () => {
    h.status = 'granted';
    h.cache = {};
    mockWriteTextFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(saveAccounts(incoming)).rejects.toThrow(/^E_KEYCHAIN_WRITE: disk full$/);
  });
});
