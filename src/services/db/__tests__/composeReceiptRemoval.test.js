import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), remove: vi.fn(), deleteCreds: vi.fn(), uncertain: vi.fn(), reply: null,
}));
vi.mock('../../transport.js', () => ({ send: (...args) => mocks.send(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  remove: (...args) => mocks.remove(...args), exists: async () => true, mkdir: vi.fn(),
}));
vi.mock('../keychain.js', () => ({
  loadKeychain: vi.fn(), deleteCredentials: (...args) => mocks.deleteCreds(...args),
  saveCredentials: vi.fn(), updateCredentials: vi.fn(), readCurrentCredentials: vi.fn(),
  beginNativeWrite: () => () => {}, assertLegacyWriteAllowed: vi.fn(),
  markNativeMutationUncertain: (...args) => mocks.uncertain(...args),
  invalidateCredentialsCache: vi.fn(),
  parseKeychainValue: vi.fn(), getAccountsFromKeychain: vi.fn(),
}));
vi.mock('../../keychainSession.js', () => ({}));

let accounts;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.reply = { outcome: 'complete', accountId: 'a' };
  mocks.send.mockImplementation(async command => {
    if (command === 'accounts.remove_local') return mocks.reply;
    throw new Error(`unexpected second destructive call: ${command}`);
  });
  accounts = await import('../accounts.js');
});

it('uses one native removal result without a renderer receipt, keychain or filesystem deletion', async () => {
  expect(await accounts.deleteAccount('a')).toEqual({ outcome: 'complete', accountId: 'a' });
  expect(mocks.send.mock.calls).toEqual([['accounts.remove_local', { accountId: 'a' }]]);
  expect(mocks.deleteCreds).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it.each([
  { outcome: 'busy', accountId: 'a', effects: 'none' },
  { outcome: 'incomplete', accountId: 'a', stage: 'credentials', completion: 'unknown',
    retry: 'afterSettlement', residuals: ['accountTree'] },
])('keeps $outcome as a refusal with no second renderer deletion path', async reply => {
  mocks.reply = reply;
  await expect(accounts.deleteAccount('a')).rejects.toMatchObject({ outcome: reply.outcome, result: reply });
  expect(mocks.send.mock.calls).toEqual([['accounts.remove_local', { accountId: 'a' }]]);
  expect(mocks.deleteCreds).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it.each([
  ['mismatched ID', { outcome: 'complete', accountId: 'b' }],
  ['extra field', { outcome: 'complete', accountId: 'a', version: 9 }],
  ['unbounded residual', { outcome: 'incomplete', accountId: 'a', stage: 'credentials', completion: 'unknown',
    retry: 'afterSettlement', residuals: ['unboundedPath'] }],
  ['null reply', null],
])('rejects %s native removal reply', async (_case, reply) => {
  mocks.reply = reply;
  await expect(accounts.deleteAccount('a')).rejects.toThrow('errors.accountsWriteFailed');
  expect(mocks.uncertain).toHaveBeenCalled();
  expect(mocks.deleteCreds).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it('does not call any renderer cleanup after a lost native reply', async () => {
  mocks.send.mockRejectedValue(new Error('transport gone'));
  await expect(accounts.deleteAccount('a')).rejects.toThrow('errors.accountsWriteFailed');
  expect(mocks.send.mock.calls).toEqual([['accounts.remove_local', { accountId: 'a' }]]);
  expect(mocks.deleteCreds).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
