import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn(), save: vi.fn(), load: vi.fn(), order: [] }));
vi.mock('../../transport.js', () => ({ send: (...args) => mocks.send(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (...a) => mocks.read(...a), writeTextFile: (...a) => mocks.write(...a),
  remove: (...a) => mocks.remove(...a), exists: async () => true, mkdir: vi.fn(),
}));
vi.mock('../keychain.js', () => ({
  loadKeychain: (...a) => mocks.load(...a), saveKeychain: (...a) => mocks.save(...a),
  parseKeychainValue: (_id, raw) => JSON.parse(raw), getAccountsFromKeychain: vi.fn(),
}));
vi.mock('../../keychainSession.js', () => ({}));
let accounts;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.order = [];
  mocks.send.mockImplementation(async (command) => {
    mocks.order.push(command);
    if (command === 'get_app_data_dir') return '/app';
    return { removed: 1 };
  });
  mocks.load.mockResolvedValue({ a: JSON.stringify({ email: 'a@example.test' }), b: JSON.stringify({ email: 'b@example.test' }) });
  mocks.read.mockResolvedValue(JSON.stringify([{ id: 'a' }, { id: 'b' }]));
  mocks.write.mockImplementation(async () => mocks.order.push('write'));
  mocks.save.mockImplementation(async () => mocks.order.push('save-keychain'));
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
  expect(mocks.write).toHaveBeenCalledWith('/app/accounts.json', JSON.stringify([{ id: 'b' }], null, 2));
  expect(mocks.remove).toHaveBeenCalledWith('/app/Maildir/a', { recursive: true });
});
it('receipt cleanup failure leaves account and Maildir mutations uncalled', async () => {
  mocks.send.mockRejectedValueOnce(new Error('receipt store unavailable'));
  await expect(accounts.deleteAccount('a')).rejects.toThrow('receipt store unavailable');
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('can retry account removal after successful idempotent receipt cleanup', async () => {
  await accounts.deleteAccount('a');
  await accounts.deleteAccount('a');
  expect(mocks.send.mock.calls.filter(([n]) => n === 'compose.receipts.remove_account')).toHaveLength(2);
});
