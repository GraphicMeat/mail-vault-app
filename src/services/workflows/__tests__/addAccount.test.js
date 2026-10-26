import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {}, reply: null, failure: null, aliases: [] }));
vi.mock('../../db', () => ({ addAccountNative: async () => { if (h.failure) throw h.failure; return h.reply; } }));
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => h.state, setState: fn => Object.assign(h.state, fn(h.state)) } }));
vi.mock('../../aliases', () => ({ scheduleAliasRefresh: a => h.aliases.push(a) }));
const { addAccount } = await import('../addAccount.js');
beforeEach(() => {
  h.state = { accounts: [], activateAccount: vi.fn(async () => {}) }; h.aliases = []; h.failure = null;
  h.reply = { ok: true, account: { id: 'a', email: 'a@example.test', imapHost: 'h' }, connectionCheck: { host: 'h', messageCount: 3, fromAddress: null }, hostChanged: false, version: 1, credentialVersion: 1 };
});
it('completes first add while activation never resolves, using only native metadata', async () => {
  h.state.activateAccount.mockImplementation(() => new Promise(() => {}));
  const result = await addAccount({ email: 'a@example.test', password: 'synthetic-secret' });
  await vi.dynamicImportSettled();
  expect(result).toEqual({ ...h.reply.account, connectionCheck: h.reply.connectionCheck });
  expect(h.state.accounts).toEqual([h.reply.account]); expect(h.aliases).toEqual([h.reply.account]);
  expect(h.state.activateAccount).toHaveBeenCalledWith('a', 'INBOX');
});
it('second add schedules aliases without activating', async () => {
  h.state.accounts = [{ id: 'older', email: 'older@example.test' }];
  await addAccount({ email: 'a@example.test' }); await vi.dynamicImportSettled();
  expect(h.state.accounts).toHaveLength(2); expect(h.aliases).toEqual([h.reply.account]); expect(h.state.activateAccount).not.toHaveBeenCalled();
});
it('activation rejection stays nonfatal after accepted native save', async () => {
  h.state.activateAccount.mockRejectedValue(new Error('synthetic activation'));
  await expect(addAccount({ email: 'a@example.test' })).resolves.toMatchObject({ id: 'a' });
  await vi.dynamicImportSettled(); expect(h.state.accounts).toEqual([h.reply.account]);
});
it('native refusal leaves store, aliases and activation untouched', async () => {
  h.failure = new Error('synthetic native refusal');
  await expect(addAccount({ email: 'a@example.test' })).rejects.toThrow('synthetic native refusal');
  await vi.dynamicImportSettled(); expect(h.state.accounts).toEqual([]); expect(h.aliases).toEqual([]); expect(h.state.activateAccount).not.toHaveBeenCalled();
});
it.each([null, { host: 'h', messageCount: null, fromAddress: null }, { host: 'h', messageCount: 4, fromAddress: 'alias@example.test' }])('returns native summary %j without putting it in the store', async connectionCheck => {
  h.reply.connectionCheck = connectionCheck;
  const result = await addAccount({ email: 'a@example.test' });
  expect(result.connectionCheck).toEqual(connectionCheck); expect(h.state.accounts[0]).not.toHaveProperty('connectionCheck');
});
