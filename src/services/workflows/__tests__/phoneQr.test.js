import { it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ status: 'granted', accounts: [] }));
const mockDaemonCall = vi.fn(async () => ({ frames: ['<svg/>'], count: 1, skipped: [] }));
vi.mock('../../daemonClient', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));
vi.mock('../../db', () => ({
  getAccounts: vi.fn(async () => h.accounts),
  saveAccounts: vi.fn(),
  accountLogicalKey: () => '',
}));
vi.mock('../../keychainSession', () => ({ getStatus: () => h.status, E_KEYCHAIN_UNAVAILABLE: 'E_KEYCHAIN_UNAVAILABLE' }));
vi.mock('../../transfer/settingsTransfer', () => ({ collectSettings: vi.fn(), applySettings: vi.fn() }));

const { phoneQr } = await import('../transferAccounts');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useThemeStore } = await import('../../../stores/themeStore');

const pristine = useSettingsStore.getState();
const pristineTheme = useThemeStore.getState();

beforeEach(() => {
  mockDaemonCall.mockClear();
  h.status = 'granted';
  h.accounts = [{ id: 'a', email: 'a@x.test', imapHost: 'imap.x.test', password: 'pw' }];
  useSettingsStore.setState(pristine, true);
  useThemeStore.setState(pristineTheme, true);
});

const sent = () => mockDaemonCall.mock.calls[0][1];

it('hands every account and the password to transfer.phone_qr and returns its reply', async () => {
  const out = await phoneQr({ password: 'correct horse battery' });
  expect(mockDaemonCall).toHaveBeenCalledTimes(1);
  expect(mockDaemonCall.mock.calls[0][0]).toBe('transfer.phone_qr');
  expect(sent().password).toBe('correct horse battery');
  expect(sent().accounts.map(a => [a.id, a.email, a.password])).toEqual([['a', 'a@x.test', 'pw']]);
  expect(out).toEqual({ frames: ['<svg/>'], count: 1, skipped: [] });
});

it('sends the display name the desktop sends mail with, not the account form name', async () => {
  h.accounts = [
    { id: 'a', email: 'a@x.test', name: 'Form Name', password: 'pw' },
    { id: 'b', email: 'b@x.test', name: 'Only Form', password: 'pw' },
  ];
  useSettingsStore.setState({ displayNames: { a: 'Ann Desk' } });
  await phoneQr({ password: 'correct horse battery' });
  expect(sent().accounts.map(a => a.name)).toEqual(['Ann Desk', 'Only Form']);
});

it('sends hidden accounts marked hidden', async () => {
  h.accounts = [{ id: 'a', email: 'a@x.test', password: 'pw' }, { id: 'b', email: 'b@x.test', password: 'pw' }];
  useSettingsStore.setState({ hiddenAccounts: { b: true } });
  await phoneQr({ password: 'correct horse battery' });
  expect(sent().accounts.map(a => [a.id, a.hidden])).toEqual([['a', false], ['b', true]]);
});

it('sends the phone-relevant global settings and nothing machine-bound', async () => {
  useSettingsStore.setState({
    language: 'de', markAsReadMode: 'manual', markAsReadDelay: 4, confirmBeforeDelete: false, afterDeleteSelect: 'previous',
    swipeLeftAction: 'delete', swipeRightAction: 'star', sendDelay: 10, holdExternalContent: true, dateFormat: 'custom',
    customDateFormat: 'dd.MM.yy', timeFormat: '24h', threadMode: 'flat', viewStyle: 'chat', appIcon: 'teal', emailTemplates: [{ id: 't', name: 'Hi', body: 'Hello', createdAt: 'x' }],
    notificationSettings: { ...pristine.notificationSettings, showPreview: false, importantSenders: [{ match: 'boss@x.test', throughQuietHours: true }] },
  });
  useThemeStore.setState({ theme: 'light', palette: 'teal' });
  await phoneQr({ password: 'correct horse battery' });
  const s = sent().settings;
  expect(s).toMatchObject({
    language: 'de', theme: 'light', palette: 'teal', markAsReadMode: 'manual', markAsReadDelay: 4, confirmBeforeDelete: false,
    afterDeleteSelect: 'previous', swipeLeftAction: 'delete', swipeRightAction: 'star', sendDelay: 10, holdExternalContent: true,
    dateFormat: 'custom', customDateFormat: 'dd.MM.yy', timeFormat: '24h', threadMode: 'flat', viewStyle: 'chat', appIcon: 'teal', notificationPreview: false,
    importantSenders: [{ match: 'boss@x.test', throughQuietHours: true }], templates: [{ name: 'Hi', body: 'Hello' }],
  });
  for (const never of ['backupEnabled', 'cleanupRules', 'transferLimits', 'aiSettings', 'refreshInterval', 'daemonMode', 'layoutMode', 'keyboardShortcuts', 'emailListStyle', 'searchHistoryLimit']) {
    expect(s, never).not.toHaveProperty(never);
  }
});

it('sends the display, mail and notification settings the phone applies', async () => {
  useSettingsStore.setState({
    textScale: 1.25, appFont: 'atkinson', listDensity: 'compact', listPreviewLines: 2, signatureDisplay: 'collapsed',
    actionButtonDisplay: 'text-only', trackpadSwipeEnabled: false, refreshOnLaunch: false, autoDownloadAttachments: true,
    afterDeleteSameAccount: true, badgeEnabled: true, badgeMode: 'total',
    notificationSettings: { ...pristine.notificationSettings, sound: 'none' },
  });
  await phoneQr({ password: 'correct horse battery' });
  expect(sent().settings).toMatchObject({
    textScale: 1.25, appFont: 'atkinson', listDensity: 'compact', listPreviewLines: 2, signatureDisplay: 'collapsed',
    actionButtonDisplay: 'text-only', trackpadSwipeEnabled: false, refreshOnLaunch: false, autoDownloadAttachments: true,
    afterDeleteSameAccount: true, badgeEnabled: true, badgeMode: 'total', notificationSound: 'none',
  });
});

it('sends the reader quick actions as their action ids only, not the whole quickActions object', async () => {
  const qa = useSettingsStore.getState().quickActions;
  useSettingsStore.setState({
    quickActions: { ...qa, defaults: { ...qa.defaults, reader: { ...qa.defaults.reader, entries: [{ id: 'spam', action: 'spam' }, { id: 'reply', action: 'reply' }, { id: 'star', action: 'star' }] } } },
  });
  await phoneQr({ password: 'correct horse battery' });
  const s = sent().settings;
  expect(s.quickActionsReader).toEqual(['spam', 'reply', 'star']);
  expect(s).not.toHaveProperty('quickActions');
});

it('leaves the reader quick actions out while they are the desktop default, so the phone keeps its own', async () => {
  useSettingsStore.setState({ quickActions: pristine.quickActions });
  await phoneQr({ password: 'correct horse battery' });
  expect(sent().settings).not.toHaveProperty('quickActionsReader');
});

it('sends each account its own settings and its offline window inputs', async () => {
  h.accounts = [{ id: 'a', email: 'a@x.test', password: 'pw', sentFolderOverride: 'Sent Items' }, { id: 'b', email: 'b@x.test', password: 'pw' }];
  useSettingsStore.setState({
    signatures: { a: { html: '<p>Ann</p>', text: 'Ann', enabled: true } },
    sendAsAddresses: { a: 'ann@alias.test' },
    aliases: { a: [{ address: 'ann@alias.test', name: 'Ann A', source: 'manual' }] },
    fetchMode: 'keepRecent', fetchModes: { b: 'hoarder' }, localCacheDurationMonths: 6,
    notificationSettings: { ...pristine.notificationSettings, accounts: { a: { enabled: false, folders: ['INBOX'], quietHours: { enabled: true, start: '22:00', end: '07:00' } } } },
  });
  await phoneQr({ password: 'correct horse battery' });
  const [a, b] = sent().accounts;
  expect(a.phoneSettings).toEqual({
    signature: { html: '<p>Ann</p>', text: 'Ann', enabled: true },
    sendAs: 'ann@alias.test',
    aliases: [{ address: 'ann@alias.test', name: 'Ann A' }],
    sentFolderOverride: 'Sent Items',
    notifications: { enabled: false, folders: ['INBOX'], quietHours: { enabled: true, start: '22:00', end: '07:00' } },
    fetchMode: 'keepRecent',
    cacheMonths: 6,
  });
  expect(b.phoneSettings).toEqual({ fetchMode: 'hoarder', cacheMonths: 6 });
});

it('reads an empty keychain as fine', async () => {
  h.status = 'empty';
  await expect(phoneQr({ password: 'correct horse battery' })).resolves.toBeTruthy();
});

it('refuses before the daemon when the keychain could not be read', async () => {
  h.status = 'denied';
  await expect(phoneQr({ password: 'correct horse battery' })).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');
  expect(mockDaemonCall).not.toHaveBeenCalled();
});

it('never logs the password or an account', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await phoneQr({ password: 'correct horse battery' });
  const printed = JSON.stringify(log.mock.calls);
  expect(printed).not.toContain('correct horse');
  expect(printed).not.toContain('a@x.test');
  log.mockRestore();
});
