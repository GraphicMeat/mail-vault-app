import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {},
  theme: { theme: 'light', setTheme: null },
  flush: null,
}));
h.theme.setTheme = vi.fn((t) => { h.theme.theme = t; });
h.flush = vi.fn(async () => {});

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => h.settings,
    setState: (patch) => { Object.assign(h.settings, patch); },
  },
}));
vi.mock('../../../stores/themeStore', () => ({ useThemeStore: { getState: () => h.theme } }));
vi.mock('../../../stores/safeStorage', () => ({ flushSafeStorage: (...a) => h.flush(...a) }));

const { collectSettings, applySettings, GLOBAL_SETTINGS_ALLOWLIST } = await import('../settingsTransfer');

beforeEach(() => {
  h.flush.mockClear();
  h.theme.setTheme.mockClear();
  h.theme.theme = 'light';
  for (const k of Object.keys(h.settings)) delete h.settings[k];
  Object.assign(h.settings, {
    billingProfile: { customerId: 'cus_1' },
    backupSchedules: { A: { every: 'day' } },
    cleanupRules: [{ id: 'r1' }],
    undoSendDelay: 10,
    layoutMode: 'three-pane',
    signatures: { A: { html: 'sig A' }, B: { html: 'sig B' } },
    displayNames: { A: 'Alice', B: 'Bob' },
    sendAsAddresses: {},
    accountColors: { B: '#fff' },
    hiddenAccounts: {},
    accountOrder: ['B', 'A'],
    notificationSettings: { enabled: true, sound: 'chime', accounts: { A: { enabled: false }, B: { enabled: true } }, mutedViewIds: [] },
  });
});

describe('collectSettings', () => {
  it('only carries allowlisted globals and the selected accounts', () => {
    const snap = collectSettings(['A']);
    const json = JSON.stringify(snap);
    expect(json).not.toContain('billingProfile');
    expect(json).not.toContain('backupSchedules');
    expect(json).not.toContain('cleanupRules');
    expect(json).not.toContain('sig B');
    expect(snap.accountSettings.signatures).toEqual({ A: { html: 'sig A' } });
    expect(snap.accountSettings.accountColors).toEqual({});
    expect(snap.accountSettings.notificationSettings.accounts).toEqual({ A: { enabled: false } });
    expect(snap.appSettings.notificationSettings).toEqual({ enabled: true, sound: 'chime', mutedViewIds: [] });
    expect(snap.appSettings.undoSendDelay).toBe(10);
    expect(Object.keys(snap.appSettings).every(k => k === 'notificationSettings' || GLOBAL_SETTINGS_ALLOWLIST.includes(k))).toBe(true);
    expect(snap.accountOrder).toEqual(['A']);
    expect(snap.theme).toBe('light');
  });
});

describe('applySettings', () => {
  const snapshot = {
    accountSettings: {
      signatures: { X: { html: 'sig X' }, D: { html: 'dup sig' } },
      displayNames: { X: 'Xavier' },
      notificationSettings: { accounts: { X: { enabled: false } } },
    },
    accountOrder: ['X'],
    appSettings: { undoSendDelay: 30, billingProfile: { customerId: 'evil' }, notificationSettings: { sound: 'bell', accounts: { A: 'clobber' } } },
    theme: 'dark',
  };

  it('re-keys per-account settings through idMap, drops unmapped ids, and flushes to disk', async () => {
    await applySettings(snapshot, { X: 'X2' }, { applyGlobal: false });
    expect(h.settings.signatures).toEqual({ A: { html: 'sig A' }, B: { html: 'sig B' }, X2: { html: 'sig X' } });
    expect(h.settings.displayNames.X2).toBe('Xavier');
    expect(h.settings.notificationSettings.accounts.X2).toEqual({ enabled: false });
    expect(h.settings.notificationSettings.sound).toBe('chime');
    expect(h.settings.undoSendDelay).toBe(10);
    expect(h.settings.accountOrder).toEqual(['B', 'A', 'X2']);
    expect(h.theme.setTheme).not.toHaveBeenCalled();
    expect(h.flush).toHaveBeenCalledTimes(1);
  });

  it('applies allowlisted globals, notification globals and theme only when asked', async () => {
    await applySettings(snapshot, {}, { applyGlobal: true });
    expect(h.settings.undoSendDelay).toBe(30);
    expect(h.settings.billingProfile).toEqual({ customerId: 'cus_1' });
    expect(h.settings.notificationSettings.sound).toBe('bell');
    expect(h.settings.notificationSettings.accounts.A).toEqual({ enabled: false });
    expect(h.theme.setTheme).toHaveBeenCalledWith('dark');
    expect(h.flush).toHaveBeenCalledTimes(1);
  });

  it('seeds an empty order from the existing accounts so imports do not jump to the top', async () => {
    h.settings.accountOrder = [];
    await applySettings(snapshot, { X: 'X2' }, { applyGlobal: false, existingIds: ['A', 'B'] });
    expect(h.settings.accountOrder).toEqual(['A', 'B', 'X2']);
  });
});
