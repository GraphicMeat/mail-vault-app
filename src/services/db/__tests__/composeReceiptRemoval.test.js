import { beforeEach, expect, it, vi } from 'vitest';
import { fakeAccountsDaemon } from './fakeAccountsDaemon.js';
const mocks = vi.hoisted(() => ({ send: vi.fn(), write: vi.fn(), remove: vi.fn(), deleteCreds: vi.fn(), load: vi.fn(), order: [], file: null, blob: {} }));
vi.mock('../../transport.js', () => ({ send: (...args) => mocks.send(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...a) => mocks.write(...a),
  remove: (...a) => mocks.remove(...a), exists: async () => true, mkdir: vi.fn(),
}));
vi.mock('../keychain.js', () => ({
  loadKeychain: (...a) => mocks.load(...a), deleteCredentials: (...a) => mocks.deleteCreds(...a),
  saveCredentials: vi.fn(), updateCredentials: vi.fn(), readCurrentCredentials: vi.fn(),
  beginNativeWrite: () => () => {}, assertLegacyWriteAllowed: vi.fn(), markNativeMutationUncertain: vi.fn(),
  parseKeychainValue: (_id, raw) => JSON.parse(raw), getAccountsFromKeychain: vi.fn(),
}));
vi.mock('../../keychainSession.js', () => ({}));
let accounts;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.order = [];
  mocks.file = JSON.stringify([{ id: 'a' }, { id: 'b' }]);
  mocks.blob = { a: JSON.stringify({ email: 'a@example.test' }), b: JSON.stringify({ email: 'b@example.test' }) };
  const daemon = fakeAccountsDaemon({ read: () => mocks.file, write: text => { mocks.file = text; mocks.order.push('accounts-write'); } });
  mocks.send.mockImplementation(async (command, args) => {
    mocks.order.push(command);
    if (command === 'get_app_data_dir') return '/app';
    if (command.startsWith('accounts.')) return daemon.call(command, args);
    return { removed: 1 };
  });
  mocks.load.mockImplementation(async () => mocks.blob);
  mocks.deleteCreds.mockImplementation(async ids => { mocks.order.push('credentials-delete'); ids.forEach(id => delete mocks.blob[id]); });
  mocks.remove.mockImplementation(async () => mocks.order.push('remove'));
  accounts = await import('../accounts.js');
  await accounts.initDB();
  vi.clearAllMocks();
  mocks.order = [];
});
it('retires native receipts once before account keychain and file removal', async () => {
  await accounts.deleteAccount('a');
  expect(mocks.order[0]).toBe('compose.receipts.remove_account');
  expect(mocks.send).toHaveBeenCalledWith('compose.receipts.remove_account', { accountId: 'a' });
  expect(mocks.send.mock.calls.filter(([n]) => n === 'compose.receipts.remove_account')).toHaveLength(1);
  expect(mocks.order.indexOf('accounts.remove')).toBeLessThan(mocks.order.indexOf('credentials-delete'));
  expect(JSON.parse(mocks.file)).toEqual([{ id: 'b' }]);
  expect(Object.keys(mocks.blob)).toEqual(['b']);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.remove).toHaveBeenCalledWith('/app/Maildir/a', { recursive: true });
});
it('receipt cleanup failure leaves account and Maildir mutations uncalled', async () => {
  mocks.send.mockRejectedValueOnce(new Error('receipt store unavailable'));
  await expect(accounts.deleteAccount('a')).rejects.toThrow('receipt store unavailable');
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.deleteCreds).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(JSON.parse(mocks.file)).toEqual([{ id: 'a' }, { id: 'b' }]);
  expect(Object.keys(mocks.blob)).toEqual(['a', 'b']);
  expect(mocks.send.mock.calls.map(([name]) => name)).toEqual(['compose.receipts.remove_account']);
});
it('can retry account removal after successful idempotent receipt cleanup', async () => {
  await accounts.deleteAccount('a');
  await accounts.deleteAccount('a');
  expect(mocks.send.mock.calls.filter(([n]) => n === 'compose.receipts.remove_account')).toHaveLength(2);
  expect(JSON.parse(mocks.file)).toEqual([{ id: 'b' }]);
  expect(Object.keys(mocks.blob)).toEqual(['b']);
  expect(mocks.remove).toHaveBeenNthCalledWith(2, '/app/Maildir/a', { recursive: true });
});
