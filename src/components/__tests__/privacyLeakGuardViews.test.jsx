// @vitest-environment jsdom
/**
 * The privacy leak guard (privacyLeakGuard.test.jsx) for the views and
 * settings pages that render people outside the mail list and reader. A
 * separate file because these need module mocks (daemon, reader) the core
 * surfaces must not see.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { PEOPLE, FIXTURE_MESSAGE, expectNoLeak } from '../../test/privacyFixtures';

const [JOANNA, ROKAS, OWEN] = PEOPLE.names;
const [JOANNA_ADDR, ROKAS_ADDR, OWEN_ADDR] = PEOPLE.emails;
const MESSAGE = { ...FIXTURE_MESSAGE, _accountId: 'own', _mailbox: 'INBOX', isArchived: true, messageId: '<m1@test>' };
const MASKED_JOANNA = 'xxxxxx xxxxxxxxx';

const DAEMON = {
  'deleted.list': () => [{
    id: 'b1', accountId: 'own', mailbox: 'INBOX', uid: 1, deletedAt: Date.UTC(2026, 8, 27, 10),
    row: { subject: MESSAGE.subject, from: MESSAGE.from, date: '2026-09-20T08:00:00Z' },
  }],
  'net.activity': () => ({ events: [{ atMs: Date.now(), direction: 'out', process: 'helper', protocol: 'imap', host: 'imap.example.test',
    ip: '192.0.2.1', port: 993, purpose: 'sync', account: OWEN_ADDR, bytesUp: 100, bytesDown: 2000, durationMs: 1500,
    result: 'ok', commands: null, country: 'DE' }] }),
  'net.geo': () => ({ countries: [] }),
  'net.summary': () => ({ hosts: 1, sent: 0, received: 0, accounts: [] }),
  'net.retention': () => ({ retention: 'week' }),
};
vi.mock('../../services/daemonClient', () => ({
  daemonCall: vi.fn(async (method) => DAEMON[method]?.() ?? null),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../services/db', async importOriginal => ({ ...await importOriginal(), getCachedMailboxes: async () => [], saveAccount: async () => {} }));
vi.mock('../../services/aliasDiscovery', () => ({
  refreshAliases: vi.fn(async () => ({ added: [], suggestions: [], providerStatus: 'unsupported' })),
}));
vi.mock('../EmailViewer', () => ({ EmailViewer: () => null }));
vi.mock('../../services/trackerVerdicts', () => ({ backfillTrackerVerdicts: vi.fn() }));

const { usePrivacyStore } = await import('../../stores/privacyStore');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useViewStore } = await import('../../stores/viewStore');
const { notify, useFocusStore } = await import('../../stores/focusStore');
const { setPrivacyDictionary } = await import('../../utils/privacy/privacyDictionary');
const { buildNameDictionary } = await import('../../utils/privacy/piiDetector');
const { ViewPreview } = await import('../ViewPreview');
const { ExplorerView } = await import('../ExplorerView');
const { SnapshotList } = await import('../TimeCapsule');
const { default: InsightsMessages } = await import('../insights/InsightsMessages');
const { default: SenderList } = await import('../insights/SenderList');
const { DeletedEmailsSettings } = await import('../settings/DeletedEmailsSettings');
const { NotificationSettings } = await import('../settings/NotificationSettings');
const { default: InsightsPage } = await import('../insights/InsightsPage');
const { useInsightsStore } = await import('../../stores/insightsStore');
const { AccountSettings } = await import('../settings/AccountSettings');
const { NetworkActivity } = await import('../settings/NetworkActivity');
const { useNetActivityStore } = await import('../../stores/netActivityStore');
const { t } = await import('../../i18n');

const ACCOUNT = { id: 'own', name: OWEN, email: OWEN_ADDR };

beforeEach(() => {
  vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  usePrivacyStore.setState({ enabled: true, peek: false, captureMask: false });
  setPrivacyDictionary(buildNameDictionary({ names: PEOPLE.names }), { ready: true });
  useMailStore.setState({ accounts: [ACCOUNT], activeAccountId: 'own', activeMailbox: 'INBOX', emails: [MESSAGE], loadEmails: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('privacy leak guard: views and settings', () => {
  it('view builder preview', async () => {
    useViewStore.setState({ previewDef: vi.fn(async () => ({ available: true, reason: null, rows: [MESSAGE], total: 1 })) });
    render(<ViewPreview def={{ starred: true }} />);
    await screen.findByTestId('view-preview-rows');
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('explorer, by sender and by conversation', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 500, top: 0, left: 0, right: 700, bottom: 500 });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const keyOf = e => `${e._accountId}:${e._mailbox}:${e.uid}`;
    render(<ExplorerView emails={[MESSAGE]} conversationEmails={[MESSAGE]} context={{ activeAccountId: 'own', activeMailbox: 'INBOX' }}
      rootLabel="Inbox" selectedEmailIds={new Set()} getSelectionKey={keyOf} onSetSelection={() => {}} renderEmail={() => null} />);
    for (const value of ['sender', 'conversation']) {
      fireEvent.change(screen.getByTestId('explorer-grouping'), { target: { value } });
      expect(screen.getAllByTestId('explorer-group-row').length).toBe(1);
      expectNoLeak(document.body);
    }
  });

  it('time capsule snapshot list', () => {
    const noop = () => {};
    render(<SnapshotList snapshots={[]} loading={false} creating={false} error={null} confirmDelete={null}
      onOpen={noop} onCreate={noop} onRetry={noop} onDelete={noop} onConfirmDelete={noop} accountEmail={OWEN_ADDR} />);
    expect(document.body.textContent).toContain('xxxx@xxx.xxxxxxx');
    expectNoLeak(document.body);
  });

  it('insights matches and sender list', () => {
    render(<InsightsMessages messages={[{ key: 'k', subject: MESSAGE.subject, from: MESSAGE.from, eventAt: '2026-09-09T12:00:00Z',
      copies: [{ accountId: 'own', mailbox: 'INBOX', uid: 1 }] }]} onClose={() => {}} />);
    render(<SenderList senders={[{ address: JOANNA_ADDR, name: JOANNA, count: 4, received: 3, sent: 1, lastAt: '2026-09-08T12:00:00Z', automationEvidence: [] }]} />);
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('deleted emails settings', async () => {
    render(<DeletedEmailsSettings />);
    await screen.findByTestId('deleted-list');
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('insights page with a selected sender, its account filter and coverage', () => {
    const noop = vi.fn();
    useInsightsStore.setState({ isOpen: true, tab: 'map', status: 'ready', progress: null, selection: null, messages: [], error: null,
      query: { startDate: '2026-09-01', endDate: '2026-09-09', accountIds: ['own'], direction: 'received', timeZone: 'UTC', senderAddress: JOANNA_ADDR },
      preferences: { range: 'custom' },
      coverage: { status: 'partial', folders: [{ accountId: 'own', mailbox: 'INBOX', cachedHeaders: 2, knownServerMessages: 700, missingHeaders: 698 }] },
      result: { totals: { received: 1, sent: 0, both: 1 }, days: [], lanes: [], unknownDateCount: 0, fallbackDateCount: 0, uncertainIdentityCount: 0,
        senders: [{ address: JOANNA_ADDR, name: JOANNA, count: 4, received: 3, sent: 1, lastAt: '2026-09-08T12:00:00Z', automationEvidence: [] }] },
      setTab: noop, setQuery: noop, refresh: noop, selectDay: noop, loadMessages: noop, selectSender: noop });
    render(<InsightsPage onClose={() => {}} />);
    expect(screen.getByTestId('insights-clear-sender')).toBeTruthy();
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('account settings: identity header, address field and the remove confirmation', () => {
    useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, aliases: {}, dismissedAliases: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {} });
    useMailStore.setState({ mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
    render(<AccountSettings accounts={[ACCOUNT]} />);
    // The masked run is aria-hidden, so the heading is found by its place.
    expect(document.querySelector('.account-settings-identity h3').textContent).toBe('xxxx xxxxxxxx');
    expectNoLeak(document.body);
    fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionAdvanced') }));
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.removeAccount2') }));
    expect(document.body.textContent).toContain('xxxx@xxx.xxxxxxx');
    expectNoLeak(document.body);
  });

  it('network activity row', async () => {
    useNetActivityStore.setState({ events: [], frozen: null, loadError: false, remoteImages: { blocked: 0, loaded: 0 },
      query: { range: 'day', account: '', country: '' }, retention: 'week', retentionError: false });
    render(<NetworkActivity />);
    expect((await screen.findByTestId('net-account')).textContent).toBe('xxxx@xxx.xxxxxxx');
    expectNoLeak(document.body);
  });

  it('notification settings: accounts, important senders and the decision log', async () => {
    // The decision was logged while privacy was off; the log is read later, on.
    usePrivacyStore.setState({ enabled: false });
    useFocusStore.getState().abandon();
    useSettingsStore.setState({ notificationSettings: { enabled: true, showPreview: true, accounts: {}, sound: 'none',
      importantSenders: [{ match: ROKAS_ADDR, throughQuietHours: true }] } });
    await act(() => notify(`Lunch with ${JOANNA}`, '', undefined, undefined,
      { accountId: 'own', folder: 'INBOX', from: JOANNA_ADDR, domain: 'example.org', viewIds: [] }));
    usePrivacyStore.setState({ enabled: true });
    render(<NotificationSettings accounts={[ACCOUNT]} />);
    expect(document.body.textContent).toContain(`Lunch with ${MASKED_JOANNA}`);
    expectNoLeak(document.body);
  });
});
