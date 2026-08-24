import { describe, it, expect, vi } from 'vitest';

// Mock safeStorage (localStorage substitute)
vi.mock('../safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

const { useSettingsStore } = await import('../settingsStore');

describe('settingsStore defaults', () => {
  it('has cacheLimitMB default of 128', () => {
    const state = useSettingsStore.getState();
    expect(state.cacheLimitMB).toBe(128);
  });

  it('setCacheLimitMB updates the value', () => {
    const store = useSettingsStore.getState();
    store.setCacheLimitMB(256);
    expect(useSettingsStore.getState().cacheLimitMB).toBe(256);

    // Reset for other tests
    store.setCacheLimitMB(128);
  });

  it('resetSettings restores cacheLimitMB to 128', () => {
    const store = useSettingsStore.getState();
    store.setCacheLimitMB(999);
    store.resetSettings();
    expect(useSettingsStore.getState().cacheLimitMB).toBe(128);
  });
});

describe('changeServer modal state', () => {
  it('defaults changeServerAccountId to null', () => {
    expect(useSettingsStore.getState().changeServerAccountId).toBe(null);
  });

  it('openChangeServer sets the account id', () => {
    useSettingsStore.getState().openChangeServer('acct-1');
    expect(useSettingsStore.getState().changeServerAccountId).toBe('acct-1');
  });

  it('closeChangeServer clears it back to null', () => {
    useSettingsStore.getState().openChangeServer('acct-1');
    useSettingsStore.getState().closeChangeServer();
    expect(useSettingsStore.getState().changeServerAccountId).toBe(null);
  });
});

// A link alert is a phishing warning. Keyed by bare UID it was a warning about
// whichever message happened to hold that number in the mailbox you were
// looking at — account A's UID 41 lit a red flag on account B's UID 41.
describe('linkAlerts are keyed per account + mailbox', () => {
  it('keeps two accounts sharing a UID apart', () => {
    const store = useSettingsStore.getState();
    store.setLinkAlert('acct-1-INBOX-41', 'red');
    store.setLinkAlert('acct-2-INBOX-41', 'yellow');

    const { linkAlerts } = useSettingsStore.getState();
    expect(linkAlerts['acct-1-INBOX-41']).toBe('red');
    expect(linkAlerts['acct-2-INBOX-41']).toBe('yellow');
    // The old shape must not be readable any more, under any key.
    expect(linkAlerts[41]).toBeUndefined();
  });

  it('keeps two mailboxes of one account apart', () => {
    useSettingsStore.getState().setLinkAlert('acct-1-Sent-41', 'yellow');
    const { linkAlerts } = useSettingsStore.getState();
    expect(linkAlerts['acct-1-INBOX-41']).toBe('red');
    expect(linkAlerts['acct-1-Sent-41']).toBe('yellow');
  });

  it('drops the write when the message could not be located', () => {
    const before = useSettingsStore.getState().linkAlerts;
    useSettingsStore.getState().setLinkAlert(null, 'red');
    // Same object: no entry, and no key called "null" either.
    expect(useSettingsStore.getState().linkAlerts).toBe(before);
  });
});

describe('persist migration v3 → v4', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate;

  it('drops UID-keyed alerts instead of carrying them into the new shape', () => {
    // A bare UID cannot be upgraded — it does not say which mailbox or account
    // it came from — so an existing map is dropped, not translated. The alerts
    // come back as each message is opened.
    const migrated = migrate({ linkAlerts: { 41: 'red', 42: 'yellow' }, cacheLimitMB: 256 }, 3);
    expect(migrated.linkAlerts).toEqual({});
    expect(migrated.cacheLimitMB).toBe(256);
  });

  it('leaves an already-migrated map alone', () => {
    const persisted = { linkAlerts: { 'acct-1-INBOX-41': 'red' } };
    expect(migrate(persisted, 4)).toBe(persisted);
  });
});

describe('send-as address', () => {
  it('defaults to empty and round-trips per account', () => {
    const store = useSettingsStore.getState();
    expect(store.getSendAsAddress('acct-1')).toBe('');

    store.setSendAsAddress('acct-1', '  DEF@fastmail.fm  ');
    expect(useSettingsStore.getState().getSendAsAddress('acct-1')).toBe('DEF@fastmail.fm');
    // Scoped per account — a second account is untouched.
    expect(useSettingsStore.getState().getSendAsAddress('acct-2')).toBe('');

    useSettingsStore.getState().setSendAsAddress('acct-1', '');
    expect(useSettingsStore.getState().getSendAsAddress('acct-1')).toBe('');
  });
});

describe('lastComposeIdentity', () => {
  it('defaults to null', () => {
    expect(useSettingsStore.getState().lastComposeIdentity).toBeNull();
  });

  it('setLastComposeIdentity records the sending account and address', () => {
    useSettingsStore.getState().setLastComposeIdentity('acc-1', 'alias@x.com');
    expect(useSettingsStore.getState().lastComposeIdentity).toEqual({
      accountId: 'acc-1',
      address: 'alias@x.com',
    });
  });

  it('resetSettings clears it', () => {
    useSettingsStore.getState().setLastComposeIdentity('acc-1', 'alias@x.com');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().lastComposeIdentity).toBeNull();
  });
});
