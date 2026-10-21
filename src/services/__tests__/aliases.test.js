// The alias bindings (services/aliases.js): they ask the daemon with the
// account's id and login only, and put the lists it answers into the
// settings store.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => send(...a) }));
vi.mock('../../stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    flushSafeStorage: () => Promise.resolve(),
    safeStorageWritable: () => true,
  };
});

const { useSettingsStore } = await import('../../stores/settingsStore');
const { refreshAliases, scheduleAliasRefresh, scheduleAliasRefreshAll, addAlias, removeAlias } = await import('../aliases.js');

const ACCOUNT = { id: 'a1', email: 'me@example.test', authType: 'oauth2', oauth2AccessToken: 'app-held', password: 'pw' };
const DESK = { address: 'desk@example.test', name: 'Desk', source: 'manual' };
const state = () => useSettingsStore.getState();

beforeEach(() => {
  send.mockReset();
  useSettingsStore.setState({ aliases: { a2: [DESK] }, dismissedAliases: {}, sendAsAddresses: { a1: 'desk@example.test' }, displayNames: {} });
});

describe('refreshAliases', () => {
  it('asks with the id and login, keeps the lists and the name the daemon answers, and hands back the lookup', async () => {
    send.mockResolvedValue({
      added: [DESK], suggestions: [{ address: 'in@example.test' }], providerStatus: 'ok',
      aliases: [DESK], dismissed: ['gone@example.test'], displayName: 'Me Myself',
    });
    await expect(refreshAliases(ACCOUNT)).resolves.toEqual({ added: [DESK], suggestions: [{ address: 'in@example.test' }], providerStatus: 'ok' });
    expect(send).toHaveBeenCalledWith('aliases.refresh', { accountId: 'a1', loginEmail: 'me@example.test' });
    expect(state().aliases).toEqual({ a2: [DESK], a1: [DESK] });
    expect(state().dismissedAliases).toEqual({ a1: ['gone@example.test'] });
    expect(state().displayNames).toEqual({ a1: 'Me Myself' });
  });

  it('never rejects, and an answer with no lists leaves the store alone', async () => {
    send.mockRejectedValueOnce(new Error('errors.daemonUnavailable'));
    await expect(refreshAliases(ACCOUNT)).resolves.toEqual({ added: [], suggestions: [], providerStatus: 'error' });
    send.mockResolvedValueOnce({ added: [], suggestions: [], providerStatus: 'error', aliases: null, dismissed: null, displayName: null });
    await refreshAliases(ACCOUNT);
    expect(state().aliases).toEqual({ a2: [DESK] });
    await expect(refreshAliases(null)).resolves.toMatchObject({ providerStatus: 'error' });
  });
});

describe('the automatic lookup', () => {
  it('is the daemon\'s to schedule, once per account it is told about', async () => {
    send.mockResolvedValue({ scheduled: true });
    scheduleAliasRefreshAll([ACCOUNT, { id: 'a2', email: 'two@example.test' }]);
    scheduleAliasRefresh(null);
    expect(send.mock.calls).toEqual([
      ['aliases.refresh', { accountId: 'a1', loginEmail: 'me@example.test', auto: true }],
      ['aliases.refresh', { accountId: 'a2', loginEmail: 'two@example.test', auto: true }],
    ]);
  });
});

describe('addAlias and removeAlias', () => {
  it('add through the daemon and keep its lists, or say why not', async () => {
    send.mockResolvedValueOnce({ ok: true, alias: DESK, aliases: [DESK], dismissed: [] });
    await expect(addAlias(ACCOUNT, { address: 'desk@example.test', name: 'Desk' })).resolves.toEqual({ ok: true, alias: DESK });
    expect(send).toHaveBeenCalledWith('aliases.add', { accountId: 'a1', loginEmail: 'me@example.test', address: 'desk@example.test', name: 'Desk', source: 'manual' });
    expect(state().aliases.a1).toEqual([DESK]);

    send.mockResolvedValueOnce({ ok: false, reason: 'duplicate' });
    await expect(addAlias(ACCOUNT, { address: 'desk@example.test' })).resolves.toEqual({ ok: false, reason: 'duplicate' });
    send.mockRejectedValueOnce(new Error('errors.settingsNotLoaded'));
    await expect(addAlias(ACCOUNT, { address: 'x@example.test' })).resolves.toEqual({ ok: false, reason: 'errors.settingsNotLoaded' });
  });

  it('remove through the daemon, and the default From it pointed at falls back to the login', async () => {
    send.mockResolvedValueOnce({ aliases: [], dismissed: ['desk@example.test'], defaultFromCleared: true });
    await expect(removeAlias(ACCOUNT, 'desk@example.test')).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith('aliases.remove', { accountId: 'a1', loginEmail: 'me@example.test', address: 'desk@example.test' });
    expect(state().aliases.a1).toEqual([]);
    expect(state().dismissedAliases.a1).toEqual(['desk@example.test']);
    expect(state().sendAsAddresses.a1).toBe('');
  });
});
