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

describe('aliases', () => {
  it('start empty for every account', () => {
    expect(store().getAliases('a1')).toEqual([]);
    expect(store().dismissedAliases).toEqual({});
  });

  it('add a manual alias per account, and refuse bad input with a reason', () => {
    expect(store().addAlias('a1', { address: 'Desk@example.test', name: 'Desk' }, LOGIN))
      .toMatchObject({ ok: true, alias: { address: 'Desk@example.test', name: 'Desk', source: 'manual' } });
    expect(store().getAliases('a1')).toEqual([{ address: 'Desk@example.test', name: 'Desk', source: 'manual' }]);
    expect(store().getAliases('a2')).toEqual([]);

    expect(store().addAlias('a1', { address: 'desk@EXAMPLE.test' }, LOGIN)).toEqual({ ok: false, reason: 'duplicate' });
    expect(store().addAlias('a1', { address: 'ME@example.test' }, LOGIN)).toEqual({ ok: false, reason: 'login' });
    expect(store().addAlias('a1', { address: 'not an address' }, LOGIN)).toEqual({ ok: false, reason: 'invalid' });
    expect(store().getAliases('a1')).toHaveLength(1);
  });

  it('rename an alias without touching its address or source', () => {
    store().addAlias('a1', { address: 'desk@example.test', source: 'provider' }, LOGIN);
    expect(store().updateAlias('a1', 'DESK@example.test', { name: '  Front Desk ', address: 'other@example.test', source: 'manual' })).toBe(true);
    expect(store().getAliases('a1')).toEqual([{ address: 'desk@example.test', name: 'Front Desk', source: 'provider' }]);
    expect(store().updateAlias('a1', 'missing@example.test', { name: 'x' })).toBe(false);
  });

  it('remember a removed alias so discovery never brings it back', () => {
    store().addAlias('a1', { address: 'Desk@example.test' }, LOGIN);
    store().removeAlias('a1', 'desk@example.test');
    expect(store().getAliases('a1')).toEqual([]);
    expect(store().dismissedAliases).toEqual({ a1: ['desk@example.test'] });

    store().applyDiscovery('a1', LOGIN, {
      provider: { status: 'ok', aliases: [{ address: 'desk@example.test', name: '', isPrimary: false, verified: true }] },
      detected: [{ address: 'desk@example.test', name: '', count: 3, source: 'sent_from' }],
    });
    expect(store().getAliases('a1')).toEqual([]);
  });

  it('take a removed alias back when the user adds it again by hand', () => {
    store().addAlias('a1', { address: 'desk@example.test' }, LOGIN);
    store().removeAlias('a1', 'desk@example.test');
    expect(store().addAlias('a1', { address: 'Desk@example.test' }, LOGIN).ok).toBe(true);
    expect(store().dismissedAliases.a1).toEqual([]);
  });

  it('clear the default From when the alias it pointed at is removed', () => {
    store().addAlias('a1', { address: 'desk@example.test' }, LOGIN);
    store().addAlias('a1', { address: 'sales@example.test' }, LOGIN);
    store().setSendAsAddress('a1', 'Desk@example.test');
    store().removeAlias('a1', 'sales@example.test');
    expect(store().getSendAsAddress('a1')).toBe('Desk@example.test');
    store().removeAlias('a1', 'desk@example.test');
    expect(store().getSendAsAddress('a1')).toBe('');
  });

  it('leave the login out when asked for an account\'s aliases with its login', () => {
    useSettingsStore.setState({ aliases: { a1: [{ address: 'ME@example.test', name: '', source: 'manual' }, { address: 'desk@example.test', name: '', source: 'manual' }] } });
    expect(store().getAliases('a1', LOGIN).map(a => a.address)).toEqual(['desk@example.test']);
  });
});

describe('applyDiscovery', () => {
  it('stores what the merge adds and hands back suggestions and the provider status', () => {
    const out = store().applyDiscovery('a1', LOGIN, {
      provider: { status: 'ok', aliases: [
        { address: LOGIN, name: 'Me Myself', isPrimary: true, verified: true },
        { address: 'desk@example.test', name: 'Front Desk', isPrimary: false, verified: true },
      ] },
      detected: [{ address: 'inbound@example.test', name: '', count: 2, source: 'delivered_to' }],
    });
    expect(out).toEqual({
      added: [{ address: 'desk@example.test', name: 'Front Desk', source: 'provider' }],
      suggestions: [{ address: 'inbound@example.test', name: '', count: 2, source: 'delivered_to' }],
      providerStatus: 'ok',
    });
    expect(store().getAliases('a1')).toEqual(out.added);
    // The account had no name, so the provider's primary entry names it.
    expect(store().getDisplayName('a1')).toBe('Me Myself');
  });

  it('writes nothing when the lookup finds nothing new', () => {
    store().addAlias('a1', { address: 'desk@example.test' }, LOGIN);
    const before = store().aliases;
    const out = store().applyDiscovery('a1', LOGIN, {
      provider: { status: 'ok', aliases: [{ address: 'desk@example.test', name: '', isPrimary: false, verified: true }] },
      detected: [],
    });
    expect(out.added).toEqual([]);
    expect(store().aliases).toBe(before);
  });

  it('never renames an account the user named', () => {
    store().setDisplayName('a1', 'Chosen');
    store().applyDiscovery('a1', LOGIN, {
      provider: { status: 'ok', aliases: [{ address: LOGIN, name: 'Provider', isPrimary: true, verified: true }] },
      detected: [],
    });
    expect(store().getDisplayName('a1')).toBe('Chosen');
  });
});

describe('own addresses selectors', () => {
  it('list the login, the default From and every alias of one account', () => {
    store().addAlias('a1', { address: 'desk@example.test' }, LOGIN);
    store().setSendAsAddress('a1', 'desk@example.test');
    expect(selectOwnAddresses(store(), { id: 'a1', email: LOGIN })).toEqual([LOGIN, 'desk@example.test']);
  });

  it('map each account to its own list', () => {
    store().addAlias('a2', { address: 'two-alias@example.test' }, 'two@example.test');
    expect(selectOwnAddressesByAccount(store(), [{ id: 'a1', email: LOGIN }, { id: 'a2', email: 'two@example.test' }])).toEqual({
      a1: [LOGIN],
      a2: ['two@example.test', 'two-alias@example.test'],
    });
  });
});

describe('reset', () => {
  it('forgets every alias and every dismissal', () => {
    store().addAlias('a1', { address: 'desk@example.test' }, LOGIN);
    store().removeAlias('a1', 'desk@example.test');
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
