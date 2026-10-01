// @vitest-environment jsdom
/**
 * Privacy mode's contract, checked by its OUTCOME: with privacy on, no fixture
 * person may appear anywhere in what a surface renders, neither in its text
 * nor in its title/alt/aria-label/href. A new render site that forgets
 * <Private> fails here, whether or not anyone remembered to list it.
 *
 * Real stores, few mocks: a mocked child is a surface this file stops seeing.
 * Each case scans document.body (dialogs and popovers portal out of the
 * container) and first proves the fixture reached the DOM, so an empty render
 * cannot pass for a masked one.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { PEOPLE, FIXTURE_MESSAGE, expectNoLeak } from '../../test/privacyFixtures';

const { bodies } = vi.hoisted(() => ({ bodies: new Map() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 600,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey?.(index) ?? index, start: index * 72 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));
vi.mock('../../services/workflows/threadReadTimer', () => ({
  startThreadReadTimer: vi.fn(async () => {}), stopThreadReadTimer: vi.fn(() => false), forgetThreadReadTimer: vi.fn(),
  cancelThreadReadTimers: vi.fn(),
}));
vi.mock('../../services/workflows/loadSubtree', () => ({ openFolder: vi.fn() }));
vi.mock('../../services/db', async importOriginal => ({
  ...await importOriginal(),
  readLocalEmailIndex: async () => [],
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
}));

const { t } = await import('../../i18n');
const { usePrivacyStore } = await import('../../stores/privacyStore');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { setPrivacyDictionary } = await import('../../utils/privacy/privacyDictionary');
const { buildNameDictionary } = await import('../../utils/privacy/piiDetector');
const { EmailRow, CompactEmailRow } = await import('../EmailRow');
const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');
const { EmailSenderInfo } = await import('../email/EmailSenderInfo');
const { EmailHeader } = await import('../email/EmailHeaderComponent');
const { ThreadView } = await import('../email/ThreadView');
const { FullViewEmailModal } = await import('../email/FullViewEmailModal');
const { Sidebar } = await import('../Sidebar');
const { AttachmentItem } = await import('../email/AttachmentBar');
const { ChatSenderList } = await import('../ChatSenderList');
const { ChatTopicsList } = await import('../ChatTopicsList');
const { ChatBubbleView } = await import('../ChatBubbleView');
const { AddressText } = await import('../email/AddressText');
const { ContactsPickerButton } = await import('../ContactsPicker');
const { SearchTagInput } = await import('../SearchTagInput');
const { UnsubscribeHost } = await import('../UnsubscribeHost');
const { useUnsubscribeStore } = await import('../../stores/unsubscribeStore');

const [JOANNA, ROKAS, OWEN] = PEOPLE.names;
const [JOANNA_ADDR, ROKAS_ADDR, OWEN_ADDR] = PEOPLE.emails;
// The fixture message as a list row carries it: its account, the alert
// verdicts whose dialogs print the parties, and the preview text.
const MESSAGE = {
  ...FIXTURE_MESSAGE, _accountId: 'own', _mailbox: 'INBOX', _accountEmail: OWEN_ADDR,
  previewText: FIXTURE_MESSAGE.snippet, has_attachments: true,
  _senderAlert: 'red',
  _replyToMismatch: { fromDomain: 'example.org', replyToAddress: ROKAS_ADDR, replyToDomain: 'example.lt' },
  replyTo: [{ name: ROKAS, address: ROKAS_ADDR }],
  cc: [{ name: OWEN, address: OWEN_ADDR }],
};
const ACCOUNT = { id: 'own', name: OWEN, email: OWEN_ADDR, authType: 'password' };
const THREAD = { threadId: 't1', subject: MESSAGE.subject, emails: [MESSAGE], lastEmail: MESSAGE, messageCount: 1, unreadCount: 0 };
// Masked filler of the fixture name: proof the masked value, not nothing, rendered.
const MASKED_JOANNA = 'xxxxxx xxxxxxxxx';

const rowProps = () => ({
  isSelected: false, isChecked: false, onSelect: vi.fn(), onToggleSelection: vi.fn(), style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});
const threadProps = () => ({ ...rowProps(), anyChecked: false, onSelectThread: vi.fn(), onSetSelection: vi.fn() });
const clickAll = (testId) => screen.queryAllByTestId(testId).forEach(el => fireEvent.click(el));

beforeEach(() => {
  // The persisted choice counts as loaded, so the store state below is what
  // the hook reads (before hydration it masks regardless).
  vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  usePrivacyStore.setState({ enabled: true, peek: false, captureMask: false });
  setPrivacyDictionary(buildNameDictionary({ names: PEOPLE.names }), { ready: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useSettingsStore.setState({
    listPreviewLines: 2, threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', emailViewerTheme: 'light',
    sidebarLayout: 'stacked', sidebarCollapsed: false, sidebarStyle: 'list', sidebarBackupStatusLocation: 'avatar',
    displayNames: {}, hiddenAccounts: {}, accountOrder: [], accountColors: {}, unreadPerAccount: {},
    expandedFolders: {}, transferHoverEnabled: false, billingProfile: null, lastMailboxPerAccount: {},
  });
  useMailStore.setState({
    accounts: [ACCOUNT], activeAccountId: 'own', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes: [{ name: 'INBOX', path: 'INBOX' }], emails: [MESSAGE], localEmails: [], sentEmails: [],
    connectionStatus: 'connected', connectionError: null, connectionErrorType: null, error: null,
    loading: false, loadingMore: false, totalEmails: 1, viewMode: 'all', folderStatus: {},
  });
  bodies.set('own|INBOX|1', { status: 'loaded', email: { ...MESSAGE, html: `<p>Thanks, ${JOANNA}</p>`, text: `Thanks, ${JOANNA}` } });
});
afterEach(() => {
  cleanup();
  bodies.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('privacy leak guard', () => {
  it('EmailRow and CompactEmailRow, with their alert dialogs open', () => {
    for (const Row of [EmailRow, CompactEmailRow]) {
      render(<Row email={MESSAGE} unifiedInbox accountColors={{}} {...rowProps()} />);
      clickAll('sender-alert-icon');
      clickAll('reply-to-alert-icon');
      expect(document.body.textContent).toContain(MASKED_JOANNA);
      expectNoLeak(document.body);
      cleanup();
    }
  });

  it('ThreadRow and CompactThreadRow', () => {
    for (const Row of [ThreadRow, CompactThreadRow]) {
      render(<Row thread={THREAD} {...threadProps()} />);
      clickAll('sender-alert-icon');
      expect(document.body.textContent).toContain(MASKED_JOANNA);
      expectNoLeak(document.body);
      cleanup();
    }
  });

  it('reader header (EmailHeaderComponent + EmailSenderInfo + popover)', () => {
    render(<EmailHeader email={MESSAGE} expanded onToggle={vi.fn()} onToggleRaw={vi.fn()} />);
    render(<EmailSenderInfo email={MESSAGE} variant="thread" expanded onReply={vi.fn()} onToggle={vi.fn()} />);
    render(<EmailSenderInfo email={MESSAGE} variant="single" expanded onReply={vi.fn()} onToggle={vi.fn()} />);
    document.querySelectorAll(`[aria-label="${t('email.sender.senderDetails')}"]`).forEach(el => fireEvent.click(el));
    clickAll('sender-verification');
    // Each surface in this case rendered: the header, both sender-info
    // variants, the sender popover and the verification popover.
    expect(screen.getAllByTestId('sender-insights-toggle').length).toBe(3);
    expect(screen.getAllByTestId('sender-header').length).toBe(2);
    expect(screen.getAllByTestId('popover-address').length).toBeGreaterThan(0);
    expect(screen.getAllByText(t('email.header.senderDetails')).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('ThreadView headers, in both layouts', () => {
    for (const layout of ['timeline', 'split']) {
      useSettingsStore.setState({ threadReaderLayout: layout });
      render(<ThreadView thread={THREAD} onComposeReply={vi.fn()} />);
      expect(document.body.textContent).toContain(MASKED_JOANNA);
      expectNoLeak(document.body);
      cleanup();
    }
  });

  it('FullViewEmailModal header', () => {
    render(<FullViewEmailModal email={{ ...MESSAGE, html: '<p>Hello</p>', text: 'Hello' }} onClose={vi.fn()} />);
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it(`Sidebar account list with an account named ${OWEN} <${OWEN_ADDR}>`, () => {
    for (const sidebarLayout of ['stacked', 'switcher']) {
      useSettingsStore.setState({ sidebarLayout });
      render(<Sidebar />);
      // The switcher's chooser lists every account again, in a popover.
      if (sidebarLayout === 'switcher') fireEvent.click(screen.getByRole('button', { name: new RegExp(t('sidebar.switchAccount')) }));
      expect(document.body.textContent).toContain('xxxx xxxxxxx');
      expectNoLeak(document.body);
      cleanup();
    }
    useSettingsStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(document.querySelector('[aria-label*="xxxx@xxx.xxxxxxx"]')).not.toBeNull();
    expectNoLeak(document.body);
  });

  it('AttachmentBar', () => {
    render(<AttachmentItem attachment={FIXTURE_MESSAGE.attachments[0]} attachmentIndex={0} emailUid={1} accountId="own" mailbox="INBOX" />);
    expect(document.body.textContent).toContain('xx_xxxxxx_xxxxxxxxx.pdf');
    expectNoLeak(document.body);
  });

  it('ChatSenderList, ChatTopicsList and ChatBubbleView', () => {
    useMailStore.setState({ getChatEmails: () => [MESSAGE] });
    render(<ChatSenderList onSelectSender={vi.fn()} />);
    expect(screen.getAllByTestId('sender-row').length).toBeGreaterThan(0);
    const correspondent = { name: JOANNA, email: JOANNA_ADDR, emails: [MESSAGE], lastMessage: MESSAGE, unreadCount: 1 };
    render(<ChatTopicsList correspondent={correspondent} topics={[{ ...THREAD, dateRange: { start: MESSAGE.date, end: MESSAGE.date } }]} onBack={vi.fn()} onSelectTopic={vi.fn()} />);
    render(<ChatBubbleView correspondent={correspondent} threadId="t1" threadsMap={new Map([['t1', THREAD]])}
      userEmail={OWEN_ADDR} onBack={vi.fn()} />);
    // All three rendered: the topics header and the bubble view's back control.
    expect(screen.getByText(t('chat.topicsCount', { count: 1 }))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('workspace.backTopics') })).toBeTruthy();
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('plain-text body (AddressText)', () => {
    render(<div><AddressText text={`Hi ${ROKAS}, write to ${JOANNA_ADDR} or call ${PEOPLE.phones[0]}. ${JOANNA}`} /></div>);
    expect(document.body.textContent).toContain('xxxxxx.x@xxxxxxx.xxx');
    expectNoLeak(document.body);
  });

  it('compose contacts picker', () => {
    render(<ContactsPickerButton value="" onChange={vi.fn()} fieldName="TO" />);
    fireEvent.click(document.querySelector('button'));
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
  });

  it('search recipient tags and sender suggestions', () => {
    render(<SearchTagInput tags={[`from:${JOANNA_ADDR}`, `to:"${ROKAS}"`]} onTagsChange={vi.fn()} draft="Jo" onDraftChange={vi.fn()}
      onSubmit={vi.fn()} suggestions={[{ key: 's1', kind: 'sender', label: JOANNA, tags: [`from:${JOANNA_ADDR}`] }]} />);
    act(() => { document.querySelector('input')?.focus(); });
    expect(screen.getAllByTestId('search-tag').length).toBe(2);
    expect(screen.getByTestId('search-suggestion')).toBeTruthy();
    expectNoLeak(document.body);
  });

  it('unsubscribe confirm and outcome toast', () => {
    useUnsubscribeStore.setState({ pending: { name: JOANNA, sender: JOANNA_ADDR, accountId: 'own' }, busy: false,
      result: { type: 'success', kind: 'done', sender: JOANNA_ADDR } });
    render(<UnsubscribeHost />);
    expect(screen.getByText(t('unsubscribe.confirmBody'))).toBeTruthy();
    expect(document.body.textContent).toContain(MASKED_JOANNA);
    expectNoLeak(document.body);
    useUnsubscribeStore.setState({ pending: null, result: null });
  });

  it('privacy OFF: a search tag keeps its exact text in the title', () => {
    usePrivacyStore.setState({ enabled: false });
    const tag = `From:"${JOANNA}"`;
    render(<SearchTagInput tags={[tag]} onTagsChange={vi.fn()} draft="" onDraftChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByTestId('search-tag-text').getAttribute('title')).toBe(tag);
  });

  it('sanity: with privacy OFF the same EmailRow DOES show the name', () => {
    usePrivacyStore.setState({ enabled: false });
    const { container } = render(<EmailRow email={MESSAGE} {...rowProps()} />);
    expect(container.textContent).toContain(JOANNA);
  });
});
