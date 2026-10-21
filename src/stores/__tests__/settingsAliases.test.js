import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
    flushSafeStorage: () => Promise.resolve(),
    safeStorageWritable: () => true,
  };
});

const { useSettingsStore, migrateSettings, selectOwnAddresses, selectOwnAddressesByAccount } = await import('../settingsStore');

const LOGIN = 'me@example.test';
const store = () => useSettingsStore.getState();

beforeEach(() => {
  useSettingsStore.setState({ aliases: {}, dismissedAliases: {}, sendAsAddresses: {}, displayNames: {} });
});

// Adding, removing and discovering aliases is the daemon's
// (src-core/src/aliases/list.rs, src-daemon handlers/alias_store.rs, tested
// there); the store keeps the lists it answers, and edits an alias's name and
// signature itself.
const seed = (accountId, aliases) => useSettingsStore.setState(state => ({ aliases: { ...state.aliases, [accountId]: aliases } }));
const manual = (address, extra = {}) => ({ address, name: '', source: 'manual', ...extra });

describe('aliases', () => {
  it('start empty for every account', () => {
    expect(store().getAliases('a1')).toEqual([]);
    expect(store().dismissedAliases).toEqual({});
  });

  it('rename an alias without touching its address or source', () => {
    seed('a1', [{ address: 'desk@example.test', name: '', source: 'provider' }]);
    expect(store().updateAlias('a1', 'DESK@example.test', { name: '  Front Desk ', address: 'other@example.test', source: 'manual' })).toBe(true);
    expect(store().getAliases('a1')).toEqual([{ address: 'desk@example.test', name: 'Front Desk', source: 'provider' }]);
    expect(store().updateAlias('a1', 'missing@example.test', { name: 'x' })).toBe(false);
  });

  it('keep an alias signature of its own, hand it back to the account, and never store a stray shape', () => {
    seed('a1', [manual('desk@example.test', { name: 'Desk' })]);
    expect(store().getAliases('a1')[0].signature).toBeUndefined();

    expect(store().updateAlias('a1', 'DESK@example.test', { signature: { html: '<p>Desk</p>', text: 'Desk', enabled: false, junk: 1 } })).toBe(true);
    expect(store().getAliases('a1')).toEqual([
      { address: 'desk@example.test', name: 'Desk', source: 'manual', signature: { html: '<p>Desk</p>', text: 'Desk' } },
    ]);

    // A rename leaves the signature alone, and the other way round.
    store().updateAlias('a1', 'desk@example.test', { name: 'Front' });
    expect(store().getAliases('a1')[0]).toMatchObject({ name: 'Front', signature: { html: '<p>Desk</p>' } });
    store().updateAlias('a1', 'desk@example.test', { signature: { html: '', text: '' } });
    expect(store().getAliases('a1')[0]).toMatchObject({ name: 'Front', signature: { html: '', text: '' } });

    expect(store().updateAlias('a1', 'desk@example.test', { signature: null })).toBe(true);
    expect('signature' in store().getAliases('a1')[0]).toBe(false);
    expect(store().getAliases('a1')[0]).toEqual({ address: 'desk@example.test', name: 'Front', source: 'manual' });
  });

  it('leave the login out when asked for an account\'s aliases with its login', () => {
    seed('a1', [manual('ME@example.test'), manual('desk@example.test')]);
    expect(store().getAliases('a1', LOGIN).map(a => a.address)).toEqual(['desk@example.test']);
  });

  it('keep nothing that adds, removes or merges aliases in the store', () => {
    for (const action of ['addAlias', 'removeAlias', 'applyDiscovery']) expect(store()[action]).toBeUndefined();
  });
});

describe('own addresses selectors', () => {
  it('list the login, the default From and every alias of one account', () => {
    seed('a1', [manual('desk@example.test')]);
    store().setSendAsAddress('a1', 'desk@example.test');
    expect(selectOwnAddresses(store(), { id: 'a1', email: LOGIN })).toEqual([LOGIN, 'desk@example.test']);
  });

  it('map each account to its own list', () => {
    seed('a2', [manual('two-alias@example.test')]);
    expect(selectOwnAddressesByAccount(store(), [{ id: 'a1', email: LOGIN }, { id: 'a2', email: 'two@example.test' }])).toEqual({
      a1: [LOGIN],
      a2: ['two@example.test', 'two-alias@example.test'],
    });
  });
});

describe('reset', () => {
  it('forgets every alias and every dismissal', () => {
    seed('a1', [manual('desk@example.test')]);
    useSettingsStore.setState({ dismissedAliases: { a1: ['gone@example.test'] } });
    store().resetSettings();
    expect(store().aliases).toEqual({});
    expect(store().dismissedAliases).toEqual({});
  });
});

// A default From saved before aliases existed was the only way to send as an
// alias. It becomes that account's first alias, so it keeps working and shows
// up wherever aliases are listed.
describe('persist migration v13 -> v14', () => {
  it('turns a saved default From into a manual alias', () => {
    const next = migrateSettings({ sendAsAddresses: { a1: 'desk@example.test', a2: '', a3: '  ' } }, 13);
    expect(next.aliases).toEqual({ a1: [{ address: 'desk@example.test', name: '', source: 'manual' }] });
    expect(next.sendAsAddresses).toEqual({ a1: 'desk@example.test', a2: '', a3: '  ' });
  });

  it('never duplicates an alias the account already holds, and runs only once', () => {
    const saved = {
      sendAsAddresses: { a1: 'Desk@example.test' },
      aliases: { a1: [{ address: 'desk@example.test', name: 'Desk', source: 'provider' }] },
    };
    expect(migrateSettings(saved, 13).aliases).toEqual(saved.aliases);
    const once = migrateSettings({ sendAsAddresses: { a1: 'desk@example.test' } }, 13);
    expect(migrateSettings(once, 13)).toEqual(once);
    expect(migrateSettings({ sendAsAddresses: { a1: 'desk@example.test' } }, 14).aliases).toBeUndefined();
  });

  it('adds nothing when no default From was saved', () => {
    expect(migrateSettings({ cacheLimitMB: 128 }, 13)).toEqual({ cacheLimitMB: 128 });
    expect(migrateSettings({ sendAsAddresses: {} }, 13)).toEqual({ sendAsAddresses: {} });
  });
});
