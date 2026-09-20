// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { create } from 'zustand';

const mocks = vi.hoisted(() => ({
  config: { mode: 'inline', palette: 'neutral', entries: [] },
  folders: {},
  settings: { signatureDisplay: 'smart', linkSafetyEnabled: false, linkSafetyClickConfirm: false, actionButtonDisplay: 'icon-label', localMailLabels: [], emailTemplates: [], applyLocalMailLabel: vi.fn() },
  accountState: { activeAccountId: 'acct-a', activeMailbox: 'UNIFIED' },
  messageListState: { archivedEmailIds: new Set() },
  applyFlagToKeys: vi.fn().mockResolvedValue(undefined),
  purgeEverywhere: vi.fn().mockResolvedValue({ deleted: 1, failed: 0 }),
}));

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 300,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 96 })),
}) }));
vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});
vi.mock('../../hooks/useQuickActionConfiguration', () => ({
  useQuickActionConfiguration: () => ({ config: mocks.config, scope: null }),
}));
vi.mock('../QuickActions', () => ({
  QuickActions: ({ descriptors = [] }) => React.createElement('div', null,
    descriptors.map(descriptor => React.createElement('button', {
      key: descriptor.id,
      type: 'button',
      'data-testid': `chat-action-${descriptor.action}`,
      disabled: descriptor.disabled,
      ref: descriptor.buttonRef,
      onClick: () => { void descriptor.onActivate?.(); },
    }, descriptor.label))),
}));
vi.mock('../MoveToFolderDropdown', () => ({
  MoveToFolderDropdown: ({ accountId, currentMailbox, onMove }) => React.createElement('div', {
    'data-testid': 'chat-move-dropdown', 'data-account-id': accountId, 'data-current-mailbox': currentMailbox,
  }, React.createElement('button', { type: 'button', 'data-testid': 'chat-move-archive', onClick: () => onMove('Archive') }, 'Move to Archive')),
}));
vi.mock('../EmailViewer', () => ({ AttachmentItem: () => null }));
vi.mock('../email/SenderInfoPopover', () => ({ SenderInfoPopover: () => null }));
vi.mock('../email/FullViewEmailModal', () => ({ FullViewEmailModal: () => null }));
vi.mock('../LocalMailLabels', () => ({ LocalMailLabels: () => null }));
vi.mock('../LinkSafetyModal', () => ({ LinkSafetyModal: () => null }));
vi.mock('../../i18n/index.js', () => ({ t: key => key, tErr: key => key, getLocale: () => 'en', useT: () => key => key }));
vi.mock('../../utils/trackerDetect', () => ({ scanTrackers: () => ({ trackers: [], cleanedBodyHtml: '' }), summarizeTrackers: () => null }));
vi.mock('../../services/trackerVerdicts', () => ({ recordTrackerSummary: vi.fn() }));
vi.mock('../../utils/linkSafety', () => ({ scanEmailLinks: () => ({ modifiedBodyHtml: '', indicatorStyle: '', maxAlertLevel: null }), checkLinkAlert: vi.fn() }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(selector => selector(mocks.settings), { getState: () => mocks.settings }),
  isTrackerBlockingActive: () => false,
}));

const ACCOUNT_A = { id: 'acct-a', email: 'a@example.test' };
const ACCOUNT_B = { id: 'acct-b', email: 'b@example.test' };
let mailStore;
function useMailStore(selector) { return mailStore(selector); }
useMailStore.getState = (...args) => mailStore.getState(...args);
useMailStore.setState = (...args) => mailStore.setState(...args);
vi.mock('../../stores/mailStore', () => ({ useMailStore }));

vi.mock('../../stores/accountStore', () => ({ useAccountStore: selector => selector(mocks.accountState) }));
vi.mock('../../stores/messageListStore', () => ({ useMessageListStore: selector => selector(mocks.messageListState) }));
vi.mock('../../stores/themeStore', () => ({ useThemeStore: selector => selector({ theme: 'light', palette: 'graphite' }) }));
vi.mock('../../services/cacheManager', () => ({ getAccountCacheMailboxes: accountId => mocks.folders[accountId] || [] }));
vi.mock('../../services/workflows/messageMutations', () => ({
  applyFlagToKeys: (...args) => mocks.applyFlagToKeys(...args),
  purgeEverywhere: (...args) => mocks.purgeEverywhere(...args),
}));

let ChatBubbleView;

function makeMailState(overrides = {}) {
  const state = {
    activeAccountId: ACCOUNT_A.id, activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'INBOX', mailboxScope: null,
    accounts: [ACCOUNT_A, ACCOUNT_B], mailboxes: [{ path: 'Archive', name: 'Archive' }],
    selectedEmailIds: new Set(['unrelated']), backedUpKeys: null, backedUpScopes: null, backupConfigured: null,
    saveEmailsLocally: vi.fn().mockResolvedValue(undefined), removeLocalEmail: vi.fn().mockResolvedValue(undefined),
    deleteEmailFromServer: vi.fn().mockResolvedValue(undefined),
    setSelection: vi.fn(keys => mailStore.setState({ selectedEmailIds: new Set(keys) })),
    markSelectedAsRead: vi.fn().mockResolvedValue(undefined), markSelectedAsUnread: vi.fn().mockResolvedValue(undefined),
    toggleFlagged: vi.fn().mockResolvedValue(undefined),
    purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 1, failed: 0 }),
    moveEmails: vi.fn().mockResolvedValue(undefined),
  };
  return { ...state, ...overrides };
}

const action = (name, params = {}) => ({ id: params.id || name, action: name, params });
const setActions = (...entries) => { mocks.config = { mode: 'inline', palette: 'neutral', entries }; };
const email = (overrides = {}) => ({
  uid: 73, subject: 'Scoped chat message', date: '2026-09-01T10:00:00Z',
  from: { name: 'Sender', address: 'sender@example.test' }, to: [{ address: 'recipient@example.test' }],
  text: 'A short message', flags: [], source: 'server', _accountId: ACCOUNT_B.id, _mailbox: 'Sent', ...overrides,
});

function renderChat(target, onReply = vi.fn()) {
  const thread = { subject: 'Scoped chat message', emails: [target] };
  return render(<ChatBubbleView correspondent={{ name: 'Sender', email: 'sender@example.test' }}
    threadId="thread-1" threadsMap={new Map([['thread-1', thread]])} userEmail="self@example.test" onReply={onReply} />);
}

function actionButton(name) { return screen.getByTestId(`chat-action-${name}`); }
async function confirm() {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getAllByRole('button').at(-1));
}

beforeEach(async () => {
  mailStore = create(() => makeMailState());
  mocks.messageListState.archivedEmailIds = new Set();
  mocks.config = { mode: 'inline', palette: 'neutral', entries: [] };
  mocks.folders = {};
  mocks.applyFlagToKeys.mockReset().mockResolvedValue(undefined);
  mocks.purgeEverywhere.mockReset().mockResolvedValue({ deleted: 1, failed: 0 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', callback => setTimeout(callback, 0));
  if (!ChatBubbleView) ({ ChatBubbleView } = await import('../ChatBubbleView'));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('chat bubble configurable actions', () => {
  it('confirms a scoped server delete and keeps the keyboard toolbar mounted during the portal', async () => {
    setActions(action('delete'));
    const target = email({ uid: 73 });
    renderChat(target);
    const bubble = screen.getByRole('group', { name: 'chat.bubble.emailContent' });
    const container = bubble.parentElement.parentElement;
    fireEvent.mouseEnter(container);
    const button = actionButton('delete');
    fireEvent.focus(button);
    fireEvent.mouseLeave(container);
    fireEvent.click(button);

    const dialog = await screen.findByRole('alertdialog');
    expect(document.body.contains(dialog)).toBe(true);
    expect(actionButton('delete')).toBeTruthy();
    expect(mailStore.getState().deleteEmailFromServer).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(mailStore.getState().deleteEmailFromServer).toHaveBeenCalledWith(73, {
      accountId: ACCOUNT_B.id, mailboxOverride: 'Sent',
    }));
  });

  it('archives the tagged message and confirms unarchive against its exact location', async () => {
    setActions(action('archive'));
    renderChat(email({ uid: 74 }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);
    fireEvent.click(actionButton('archive'));
    expect(mailStore.getState().saveEmailsLocally).toHaveBeenCalledWith([
      expect.objectContaining({ uid: 74, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' }),
    ]);
    cleanup();

    setActions(action('unarchive'));
    renderChat(email({ uid: 75, isArchived: true }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);
    fireEvent.click(actionButton('unarchive'));
    expect(mailStore.getState().removeLocalEmail).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(mailStore.getState().removeLocalEmail).toHaveBeenCalledWith(75, {
      accountId: ACCOUNT_B.id, mailbox: 'Sent',
    }));
  });

  it('purges only when backup custody is proven and preserves unrelated selection', async () => {
    setActions(action('deleteEverywhere'));
    const key = `${ACCOUNT_B.id}:Sent:76`;
    mailStore.setState({ backedUpKeys: new Set([key]), backedUpScopes: new Set([`${ACCOUNT_B.id}:Sent`]), backupConfigured: true });
    renderChat(email({ uid: 76 }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);
    fireEvent.click(actionButton('deleteEverywhere'));
    expect(mailStore.getState().purgeSelectedEverywhere).not.toHaveBeenCalled();
    let releasePurge;
    mocks.purgeEverywhere.mockImplementationOnce(() => new Promise(resolve => { releasePurge = resolve; }));
    await confirm();
    await waitFor(() => expect(mocks.purgeEverywhere).toHaveBeenCalledWith([key]));
    mailStore.setState({ selectedEmailIds: new Set(['new-selection']) });
    releasePurge({ deleted: 1, failed: 0 });
    await waitFor(() => expect(mailStore.getState().selectedEmailIds).toEqual(new Set(['new-selection'])));
    expect(mailStore.getState().setSelection).not.toHaveBeenCalled();
    cleanup();

    mailStore.setState({ backedUpKeys: new Set([key]), backedUpScopes: new Set([`${ACCOUNT_B.id}:Sent`]), backupConfigured: false });
    renderChat(email({ uid: 76 }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);
    expect(screen.queryByTestId('chat-action-deleteEverywhere')).toBeNull();
  });

  it('moves, marks read, and stars with the full account-mailbox key', async () => {
    setActions(action('move'), action('toggleRead'), action('star'));
    const moveEmails = mailStore.getState().moveEmails;
    renderChat(email({ uid: 77 }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);

    fireEvent.click(actionButton('move'));
    const picker = await screen.findByTestId('chat-move-dropdown');
    expect(picker.getAttribute('data-account-id')).toBe(ACCOUNT_B.id);
    expect(picker.getAttribute('data-current-mailbox')).toBe('Sent');
    fireEvent.click(screen.getByTestId('chat-move-archive'));
    expect(moveEmails).toHaveBeenCalledWith([`${ACCOUNT_B.id}:Sent:77`], 'Archive');

    fireEvent.click(actionButton('toggleRead'));
    await waitFor(() => expect(mocks.applyFlagToKeys).toHaveBeenCalledWith([`${ACCOUNT_B.id}:Sent:77`], '\\Seen', true));
    expect(mailStore.getState().setSelection).not.toHaveBeenCalled();
    expect(mailStore.getState().selectedEmailIds).toEqual(new Set(['unrelated']));

    fireEvent.click(actionButton('star'));
    expect(mocks.applyFlagToKeys).toHaveBeenLastCalledWith([`${ACCOUNT_B.id}:Sent:77`], '\\Flagged', true);
  });

  it('hides server mutations for read-only and local-only messages while keeping local unarchive', () => {
    setActions(action('deleteServer'), action('deleteEverywhere'), action('move'), action('markRead'), action('star'));
    renderChat(email({ uid: 78, _insightsReadOnly: true }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);
    for (const name of ['deleteServer', 'deleteEverywhere', 'move', 'markRead', 'star']) expect(screen.queryByTestId(`chat-action-${name}`)).toBeNull();
    cleanup();

    setActions(action('deleteServer'), action('move'), action('markRead'), action('star'), action('unarchive'));
    renderChat(email({ uid: 79, source: 'local-only', isArchived: true }));
    fireEvent.mouseEnter(screen.getByRole('group').parentElement.parentElement);
    for (const name of ['deleteServer', 'move', 'markRead', 'star']) expect(screen.queryByTestId(`chat-action-${name}`)).toBeNull();
    expect(screen.queryByTestId('chat-action-unarchive')).not.toBeNull();
  });
});
