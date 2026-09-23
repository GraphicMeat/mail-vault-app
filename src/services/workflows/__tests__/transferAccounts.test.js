import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ status: 'empty', existing: [], settings: {} }));

const mockDaemonCall = vi.fn(async (method) => {
  if (method === 'transfer.export') return { data: 'QkFTRTY0' };
  if (method === 'transfer.apply_config') return { tagsAdded: 0, fieldsAdded: 0, viewsAdded: 0, rulesAdded: 0, aiKeyStored: false, aiKeyError: false };
  return {};
});
vi.mock('../../daemonClient', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));

const mockSaveAccounts = vi.fn(async () => {
  if (h.status !== 'granted' && h.status !== 'empty') throw new Error('E_KEYCHAIN_UNAVAILABLE');
});
vi.mock('../../db', () => ({
  getAccounts: vi.fn(async () => h.existing),
  saveAccounts: (...a) => mockSaveAccounts(...a),
  accountLogicalKey: (a) => `${(a.email || '').toLowerCase()}@${(a.imapHost || a.oauth2Provider || '').toLowerCase()}`,
}));
vi.mock('../../keychainSession', () => ({ getStatus: () => h.status, E_KEYCHAIN_UNAVAILABLE: 'E_KEYCHAIN_UNAVAILABLE' }));

const mockSetSettings = vi.fn((patch) => Object.assign(h.settings, patch));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => h.settings, setState: (...a) => mockSetSettings(...a) },
}));
vi.mock('../../../stores/themeStore', () => ({ useThemeStore: { getState: () => ({ theme: 'dark', setTheme: vi.fn() }) } }));
vi.mock('../../../stores/safeStorage', () => ({ flushSafeStorage: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '9.9.9' }));

const { exportTransfer, applyImport, planImport } = await import('../transferAccounts');

const acct = (id, email, extra = {}) => ({ id, email, imapHost: 'imap.x.test', password: 'pw', ...extra });

function bundleOf(accounts, signatures = {}) {
  return {
    formatVersion: 1,
    accounts,
    accountSettings: { signatures },
    accountOrder: accounts.map(a => a.id),
    appSettings: { undoSendDelay: 5 },
    theme: 'light',
    appConfig: { tags: [] },
    aiEndpointKey: null,
  };
}

beforeEach(() => {
  mockDaemonCall.mockClear();
  mockSaveAccounts.mockClear();
  mockSetSettings.mockClear();
  h.status = 'empty';
  h.existing = [];
  for (const k of Object.keys(h.settings)) delete h.settings[k];
  Object.assign(h.settings, { signatures: {}, accountOrder: [], notificationSettings: { accounts: {} } });
});

describe('applyImport', () => {
  it('saves every new selected account in ONE batch, keeping their ids', async () => {
    const accounts = [acct('a', 'a@x.test'), acct('b', 'b@x.test'), acct('c', 'c@x.test')];
    const res = await applyImport(bundleOf(accounts), { selectedIds: ['a', 'b', 'c'], applyAppSettings: false });

    expect(mockSaveAccounts).toHaveBeenCalledTimes(1);
    expect(mockSaveAccounts.mock.calls[0][0].map(a => a.id)).toEqual(['a', 'b', 'c']);
    expect(res).toEqual({ imported: 3, aiKeyError: false });
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });

  it('rejects with E_KEYCHAIN_UNAVAILABLE on a denied keychain and applies nothing', async () => {
    h.status = 'denied';
    const b = bundleOf([acct('a', 'a@x.test')], { a: { html: 'sig' } });
    await expect(applyImport(b, { selectedIds: ['a'], applyAppSettings: true })).rejects.toThrow(/^E_KEYCHAIN_UNAVAILABLE/);
    expect(mockSetSettings).not.toHaveBeenCalled();
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });

  it('maps a duplicate (same logical key) to the existing id, never saves it, and drops its settings', async () => {
    h.existing = [acct('local-1', 'DUP@x.test')];
    const b = bundleOf([acct('file-1', 'dup@x.test'), acct('n', 'new@x.test')], {
      'file-1': { html: 'dup sig' }, n: { html: 'new sig' },
    });
    await applyImport(b, { selectedIds: ['file-1', 'n'], applyAppSettings: true });

    expect(mockSaveAccounts.mock.calls[0][0].map(a => a.id)).toEqual(['n']);
    expect(h.settings.signatures).toEqual({ n: { html: 'new sig' } });
    const call = mockDaemonCall.mock.calls.find(([m]) => m === 'transfer.apply_config');
    expect(call[1].accountMap).toEqual({ 'file-1': 'local-1', n: 'n' });
    expect(call[1].appConfig).toEqual({ tags: [] });
    expect('aiEndpointKey' in call[1] && call[1].aiEndpointKey !== undefined).toBe(false);
  });

  it('gives an id collision with a different account a fresh id and re-keys its signature', async () => {
    h.existing = [acct('same', 'someone-else@x.test')];
    const b = bundleOf([acct('same', 'me@x.test')], { same: { html: 'my sig' } });
    await applyImport(b, { selectedIds: ['same'], applyAppSettings: false });

    const saved = mockSaveAccounts.mock.calls[0][0][0];
    expect(saved.id).not.toBe('same');
    expect(saved.email).toBe('me@x.test');
    expect(h.settings.signatures).toEqual({ [saved.id]: { html: 'my sig' } });
    expect(h.settings.accountOrder).toEqual(['same', saved.id]);
  });

  it('skips unselected accounts and surfaces aiKeyError as a soft warning', async () => {
    mockDaemonCall.mockImplementationOnce(async () => ({ aiKeyStored: false, aiKeyError: true }));
    const b = bundleOf([acct('a', 'a@x.test'), acct('b', 'b@x.test')]);
    b.aiEndpointKey = 'sk-test';
    const res = await applyImport(b, { selectedIds: ['b'], applyAppSettings: true });

    expect(mockSaveAccounts.mock.calls[0][0].map(a => a.id)).toEqual(['b']);
    expect(res).toEqual({ imported: 1, aiKeyError: true });
    expect(mockDaemonCall.mock.calls[0][1].accountMap).toEqual({ b: 'b' });
    expect(mockDaemonCall.mock.calls[0][1].aiEndpointKey).toBe('sk-test');
  });
});

describe('planImport', () => {
  it('flags accounts already on this machine', () => {
    const { rows } = planImport(bundleOf([acct('f1', 'a@x.test'), acct('f2', 'b@x.test')]), [acct('local', 'A@x.test')]);
    expect(rows).toEqual([
      { fileId: 'f1', email: 'a@x.test', provider: 'imap.x.test', alreadyAdded: true, targetId: 'local' },
      { fileId: 'f2', email: 'b@x.test', provider: 'imap.x.test', alreadyAdded: false, targetId: null },
    ]);
  });
});

describe('exportTransfer', () => {
  it('rejects with E_KEYCHAIN_UNAVAILABLE unless the keychain read was granted, without calling the daemon', async () => {
    h.status = 'denied';
    await expect(exportTransfer({ accountIds: ['a'], includeAppSettings: true, password: 'x'.repeat(12) }))
      .rejects.toThrow(/^E_KEYCHAIN_UNAVAILABLE/);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });

  it('sends only the chosen accounts and nulls app settings when excluded', async () => {
    h.status = 'granted';
    h.existing = [acct('a', 'a@x.test'), acct('b', 'b@x.test')];
    h.settings.signatures = { a: { html: 'A' }, b: { html: 'B' } };
    h.settings.undoSendDelay = 7;
    const data = await exportTransfer({ accountIds: ['a'], includeAppSettings: false, password: 'x'.repeat(12) });

    expect(data).toBe('QkFTRTY0');
    const [method, params] = mockDaemonCall.mock.calls[0];
    expect(method).toBe('transfer.export');
    expect(params.includeAppConfig).toBe(false);
    expect(params.bundle.accounts.map(a => a.id)).toEqual(['a']);
    expect(params.bundle.accountSettings.signatures).toEqual({ a: { html: 'A' } });
    expect(params.bundle.appSettings).toBeNull();
    expect(params.bundle.theme).toBeNull();
    expect(params.bundle.appVersion).toBe('9.9.9');
  });
});
