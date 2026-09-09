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

const { useSettingsStore, isTrackerBlockingActive, DEFAULT_SHORTCUTS, _mergePersistedSettings } = await import('../settingsStore');

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

describe('spellcheckEnabled', () => {
  it('defaults to on — the toggle takes it away, it does not grant it', () => {
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
  });

  it('setSpellcheckEnabled stores a boolean, whatever it was handed', () => {
    useSettingsStore.getState().setSpellcheckEnabled(false);
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(false);

    // The toolbar hands it `!spellcheckEnabled`, but a truthy non-boolean must
    // not reach `spellCheck={...}` — React would render the string.
    useSettingsStore.getState().setSpellcheckEnabled('yes');
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
  });

  it('resetSettings restores it to on', () => {
    useSettingsStore.getState().setSpellcheckEnabled(false);
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
  });
});

describe('tracker blocking is premium', () => {
  const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
  const FREE = { hasSubscription: false };

  it('defaults the flag on so a new subscriber is protected without hunting for a switch', () => {
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().trackerBlockingEnabled).toBe(true);
  });

  it('is NOT active for a free profile, however the flag reads', () => {
    useSettingsStore.setState({ billingProfile: FREE, trackerBlockingEnabled: true, shareGrant: null });
    // The flag alone is what a lapsed subscription leaves behind. Reading it
    // directly would render the "blocked" glyph over a beacon that fired.
    expect(useSettingsStore.getState().trackerBlockingEnabled).toBe(true);
    expect(isTrackerBlockingActive(useSettingsStore.getState())).toBe(false);
  });

  it('is active only when a live subscription and the switch agree', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, trackerBlockingEnabled: true, shareGrant: null });
    expect(isTrackerBlockingActive(useSettingsStore.getState())).toBe(true);

    useSettingsStore.setState({ trackerBlockingEnabled: false });
    expect(isTrackerBlockingActive(useSettingsStore.getState())).toBe(false);
  });

  it('refuses the setter without premium, and honours it with', () => {
    useSettingsStore.setState({ billingProfile: FREE, trackerBlockingEnabled: false, shareGrant: null });
    useSettingsStore.getState().setTrackerBlockingEnabled(true);
    expect(useSettingsStore.getState().trackerBlockingEnabled).toBe(false);

    // Negative control: the setter does work — it is the gate that refused.
    useSettingsStore.setState({ billingProfile: PREMIUM });
    useSettingsStore.getState().setTrackerBlockingEnabled(true);
    expect(useSettingsStore.getState().trackerBlockingEnabled).toBe(true);
  });

  it('stores a tracker verdict per scoped key, and drops one with no key', () => {
    useSettingsStore.setState({ trackerAlerts: {} });
    const info = { count: 2, vendors: ['MailChimp'] };
    useSettingsStore.getState().setTrackerAlert('acct-1-INBOX-41', info);
    useSettingsStore.getState().setTrackerAlert(null, info);
    expect(useSettingsStore.getState().trackerAlerts).toEqual({ 'acct-1-INBOX-41': info });
  });
});

describe('threadMode', () => {
  it('defaults to grouped', () => {
    expect(useSettingsStore.getState().threadMode).toBe('grouped');
  });

  it('setThreadMode writes the value', () => {
    useSettingsStore.getState().setThreadMode('flat');
    expect(useSettingsStore.getState().threadMode).toBe('flat');
    useSettingsStore.getState().setThreadMode('grouped');
  });

  it('resetSettings restores grouped', () => {
    useSettingsStore.getState().setThreadMode('expandable');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().threadMode).toBe('grouped');
  });
});

describe('emailRowHighlight', () => {
  it('defaults to following the pointer', () => {
    expect(useSettingsStore.getState().emailRowHighlight).toBe('hover');
  });

  it('setEmailRowHighlight writes the value', () => {
    useSettingsStore.getState().setEmailRowHighlight('selection');
    expect(useSettingsStore.getState().emailRowHighlight).toBe('selection');
    useSettingsStore.getState().setEmailRowHighlight('hover');
  });

  it('resetSettings restores pointer highlighting', () => {
    useSettingsStore.getState().setEmailRowHighlight('selection');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().emailRowHighlight).toBe('hover');
  });
});

describe('afterDeleteSelect', () => {
  it('defaults to selecting nothing', () => {
    expect(useSettingsStore.getState().afterDeleteSelect).toBe('none');
  });

  it('setAfterDeleteSelect writes the value', () => {
    useSettingsStore.getState().setAfterDeleteSelect('next');
    expect(useSettingsStore.getState().afterDeleteSelect).toBe('next');
  });

  it('resetSettings restores none', () => {
    useSettingsStore.getState().setAfterDeleteSelect('next');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().afterDeleteSelect).toBe('none');
  });
});

describe('updateTrack', () => {
  it('is unset by default so the build picks its own feed', () => {
    expect(useSettingsStore.getState().updateTrack).toBeNull();
  });

  it('setUpdateTrack writes the value', () => {
    useSettingsStore.getState().setUpdateTrack('nightly');
    expect(useSettingsStore.getState().updateTrack).toBe('nightly');
  });

  it('resetSettings restores the unset default', () => {
    useSettingsStore.getState().setUpdateTrack('nightly');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().updateTrack).toBeNull();
  });
});

describe('autoDownloadAttachments', () => {
  it('is off by default', () => {
    expect(useSettingsStore.getState().autoDownloadAttachments).toBe(false);
  });

  it('setAutoDownloadAttachments turns it on', () => {
    useSettingsStore.getState().setAutoDownloadAttachments(true);
    expect(useSettingsStore.getState().autoDownloadAttachments).toBe(true);
    useSettingsStore.getState().setAutoDownloadAttachments(false);
  });
});

// persist's `merge` option, exercised directly: a persisted install that
// predates a new shortcut binding must gain it rather than render "—" for
// ever, while a binding the user did customise must survive the merge.
describe('_mergePersistedSettings (persist merge for keyboardShortcuts)', () => {
  it('backfills a shortcut missing from the persisted map while keeping a customised one', () => {
    const current = { keyboardShortcuts: { ...DEFAULT_SHORTCUTS } };
    const persisted = {
      keyboardShortcuts: (() => {
        const { toggleStar, ...rest } = DEFAULT_SHORTCUTS;
        return { ...rest, archive: 'y' };
      })(),
    };

    const merged = _mergePersistedSettings(persisted, current);

    expect(merged.keyboardShortcuts.toggleStar).toBe('s');
    expect(merged.keyboardShortcuts.archive).toBe('y');
  });

  it('keeps a shortcut the user explicitly cleared (empty string) rather than backfilling it', () => {
    const current = { keyboardShortcuts: { ...DEFAULT_SHORTCUTS } };
    const persisted = { keyboardShortcuts: { ...DEFAULT_SHORTCUTS, archive: '' } };

    const merged = _mergePersistedSettings(persisted, current);

    expect(merged.keyboardShortcuts.archive).toBe('');
  });

  it('falls back to the defaults whole when nothing has been persisted yet', () => {
    const current = { keyboardShortcuts: { ...DEFAULT_SHORTCUTS } };

    const merged = _mergePersistedSettings(undefined, current);

    expect(merged.keyboardShortcuts).toEqual(DEFAULT_SHORTCUTS);
  });
});

describe('sidebarLayout', () => {
  it('keeps the current stacked navigation as the default and reset layout', () => {
    expect(useSettingsStore.getState().sidebarLayout).toBe('stacked');
    useSettingsStore.getState().setSidebarLayout('split');
    expect(useSettingsStore.getState().sidebarLayout).toBe('split');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().sidebarLayout).toBe('stacked');
  });

  it('accepts each alternative independently of folder style and normalizes invalid choices', () => {
    useSettingsStore.getState().setSidebarStyle('tagcloud');
    for (const layout of ['stacked', 'split', 'switcher']) {
      useSettingsStore.getState().setSidebarLayout(layout);
      expect(useSettingsStore.getState().sidebarLayout).toBe(layout);
      expect(useSettingsStore.getState().sidebarStyle).toBe('tagcloud');
    }
    useSettingsStore.getState().setSidebarLayout('unknown');
    expect(useSettingsStore.getState().sidebarLayout).toBe('stacked');
    useSettingsStore.getState().setSidebarStyle('list');
  });

  it('writes a selected layout to the persisted settings', async () => {
    const { safeStorage } = await import('../safeStorage');
    useSettingsStore.getState().setSidebarLayout('switcher');
    const persisted = JSON.parse(safeStorage.getItem('mailvault-settings'));
    expect(persisted.state.sidebarLayout).toBe('switcher');
    useSettingsStore.getState().setSidebarLayout('stacked');
  });

  it('restores saved layouts and preserves existing installations without the preference', () => {
    const current = useSettingsStore.getState();
    for (const layout of ['stacked', 'split', 'switcher']) {
      expect(_mergePersistedSettings({ sidebarLayout: layout }, current).sidebarLayout).toBe(layout);
    }
    expect(_mergePersistedSettings({}, current).sidebarLayout).toBe('stacked');
    expect(_mergePersistedSettings({ sidebarLayout: 'obsolete' }, current).sidebarLayout).toBe('stacked');
  });
});

describe('sidebar density persistence', () => {
  it('saves compact density, restores it on hydration, and resets to comfortable', async () => {
    const { safeStorage } = await import('../safeStorage');
    useSettingsStore.getState().setSidebarDensity('compact');
    const persisted = JSON.parse(safeStorage.getItem('mailvault-settings'));
    expect(persisted.state.sidebarDensity).toBe('compact');
    const current = useSettingsStore.getInitialState();
    expect(_mergePersistedSettings(persisted.state, current).sidebarDensity).toBe('compact');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().sidebarDensity).toBe('comfortable');
  });

  it('uses comfortable spacing for old settings and invalid saved choices', () => {
    const current = useSettingsStore.getInitialState();
    expect(_mergePersistedSettings({}, current).sidebarDensity).toBe('comfortable');
    expect(_mergePersistedSettings({ sidebarDensity: 'invalid' }, current).sidebarDensity).toBe('comfortable');
    useSettingsStore.getState().setSidebarDensity('invalid');
    expect(useSettingsStore.getState().sidebarDensity).toBe('comfortable');
  });
});

describe('backup status placement persistence', () => {
  it.each(['avatar', 'row', 'hidden'])('persists and restores %s without changing sidebar layout or density', async placement => {
    const { safeStorage } = await import('../safeStorage');
    useSettingsStore.setState({ sidebarLayout: 'switcher', sidebarDensity: 'compact' });
    useSettingsStore.getState().setSidebarBackupStatusLocation(placement);
    const restored = _mergePersistedSettings(JSON.parse(safeStorage.getItem('mailvault-settings')).state, useSettingsStore.getInitialState());
    expect(restored.sidebarBackupStatusLocation).toBe(placement);
    expect(restored.sidebarLayout).toBe('switcher');
    expect(restored.sidebarDensity).toBe('compact');
    useSettingsStore.getState().resetSettings();
  });

  it('restores a hidden indicator without changing backup configuration and resets its placement', async () => {
    const { safeStorage } = await import('../safeStorage');
    useSettingsStore.setState({ backupGlobalEnabled: true });
    useSettingsStore.getState().setSidebarBackupStatusLocation('hidden');
    const persisted = JSON.parse(safeStorage.getItem('mailvault-settings'));
    const restored = _mergePersistedSettings(persisted.state, useSettingsStore.getInitialState());
    expect(restored.sidebarBackupStatusLocation).toBe('hidden');
    expect(restored.backupGlobalEnabled).toBe(true);
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().sidebarBackupStatusLocation).toBe('avatar');
  });

  it('defaults missing or invalid placement to the avatar', () => {
    const current = useSettingsStore.getInitialState();
    expect(_mergePersistedSettings({}, current).sidebarBackupStatusLocation).toBe('avatar');
    expect(_mergePersistedSettings({ sidebarBackupStatusLocation: 'obsolete' }, current).sidebarBackupStatusLocation).toBe('avatar');
    useSettingsStore.getState().setSidebarBackupStatusLocation('obsolete');
    expect(useSettingsStore.getState().sidebarBackupStatusLocation).toBe('avatar');
  });
});
