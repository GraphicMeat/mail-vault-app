import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {}, reply: null, failure: null }));
const updateNative = vi.fn(async () => { if (h.failure) throw h.failure; return h.reply; });
vi.mock('../../db', () => ({ updateAccountNative: (...args) => updateNative(...args), accountExpectedContext: a => ({ fields: { email: a.email }, absent: [] }) }));
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => h.state, setState: fn => Object.assign(h.state, fn(h.state)) } }));
vi.mock('../../../i18n/index.js', () => ({ t: key => key }));
const { updateAccount } = await import('../updateAccount.js');
beforeEach(() => {
  updateNative.mockClear(); h.failure = null;
  h.state = { accounts: [{ id: 'a', email: 'a@example.test', imapHost: 'old', password: 'synthetic-old', oauth2ExpiresAt: 99 }], activeAccountId: 'a', activeMailbox: 'Custom', activateAccount: vi.fn(async () => {}) };
  h.reply = { ok: true, account: { id: 'a', email: 'a@example.test', imapHost: 'new' }, connectionCheck: null, hostChanged: true, version: 1, credentialVersion: 1 };
});
it('publishes native metadata and reactivates a changed active non-Graph account', async () => {
  expect(await updateAccount('a', { password: 'synthetic-new', oauth2ExpiresAt: 1 })).toEqual(h.reply.account);
  expect(h.state.accounts).toEqual([h.reply.account]); expect(h.state.activateAccount).toHaveBeenCalledWith('a', 'Custom');
});
it.each(['inactive', 'Graph', 'native unchanged'])('does not reactivate %s', async mode => {
  if (mode === 'inactive') h.state.activeAccountId = 'other';
  if (mode === 'Graph') h.reply.account.oauth2Transport = 'graph';
  if (mode === 'native unchanged') h.reply.hostChanged = false;
  await updateAccount('a', { imapHost: 'caller' }); expect(h.state.activateAccount).not.toHaveBeenCalled();
});
it('reactivation failure does not undo accepted native metadata', async () => {
  h.state.activateAccount.mockRejectedValue(new Error('synthetic activation'));
  await expect(updateAccount('a', {})).resolves.toEqual(h.reply.account); expect(h.state.accounts).toEqual([h.reply.account]);
});
it('supported removals and submitted secrets are never merged back over native metadata', async () => {
  h.state.accounts[0].oauth2ClientId = 'old-client'; h.state.accounts[0].jmapUsername = 'old-login';
  await updateAccount('a', { oauth2ClientId: undefined, jmapUsername: undefined, password: 'synthetic-new' });
  expect(h.state.accounts).toEqual([h.reply.account]);
});
it('a missing UI account refuses before native dispatch', async () => {
  await expect(updateAccount('missing', {})).rejects.toThrow('errors.accountNotFound'); expect(updateNative).not.toHaveBeenCalled();
});
it('unknown native completion preserves the current view and never activates', async () => {
  const before = structuredClone(h.state.accounts); h.failure = new Error('errors.accountsWriteFailed');
  await expect(updateAccount('a', {})).rejects.toThrow('errors.accountsWriteFailed');
  expect(h.state.accounts).toEqual(before); expect(h.state.activateAccount).not.toHaveBeenCalled();
});
