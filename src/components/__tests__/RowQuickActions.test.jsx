// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';

const mocks = vi.hoisted(() => ({
  config: null,
  openCompose: vi.fn(),
  openExport: vi.fn(),
  replyTarget: vi.fn(),
  reloadListInView: vi.fn(),
  setDeleteUndo: vi.fn(),
  foldersByAccount: {},
}));

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_target, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)),
    has: () => true,
  });
});

vi.mock('../../hooks/useQuickActionConfiguration', () => ({
  useQuickActionConfiguration: () => ({ config: mocks.config, scope: null }),
}));

vi.mock('../QuickActions', () => ({
  QuickActions: ({ descriptors = [] }) => React.createElement('div', null,
    descriptors.filter(descriptor => !descriptor.hidden).map(descriptor => React.createElement('button', {
      key: descriptor.id,
      type: 'button',
      'data-testid': `quick-action-${descriptor.id}`,
      'data-action': descriptor.action,
      disabled: descriptor.disabled,
      onClick: event => { void descriptor.onActivate?.(event); },
    }, descriptor.label))),
}));

vi.mock('../MoveToFolderDropdown', () => ({ MoveToFolderDropdown: () => null }));
vi.mock('../email/MessageStateIcon', () => ({ useBackupScan: () => null, isBackedUp: () => false }));
vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => key => key, getLocale: () => 'en' }));
vi.mock('../../utils/composeOpener', () => ({ openCompose: (...args) => mocks.openCompose(...args) }));
vi.mock('../../utils/replyTarget', () => ({ replyTarget: (...args) => mocks.replyTarget(...args) }));
vi.mock('../../stores/exportStore', () => ({ useExportStore: { getState: () => ({ openExport: mocks.openExport }) } }));
vi.mock('../../services/cacheManager', () => ({
  getAccountCacheMailboxes: accountId => mocks.foldersByAccount[accountId] || [],
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  reloadListInView: (...args) => mocks.reloadListInView(...args),
  setDeleteUndo: (...args) => mocks.setDeleteUndo(...args),
}));

const ACCOUNT_A = { id: 'acct-a', email: 'a@example.test' };
const ACCOUNT_B = { id: 'acct-b', email: 'b@example.test' };

let useMailStoreMock;
let useSettingsStoreMock;
let useTagStoreMock;

function mailState(overrides = {}) {
  const state = {
    activeAccountId: ACCOUNT_A.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    accounts: [ACCOUNT_A, ACCOUNT_B],
    mailboxes: [{ name: 'Archive', path: 'Archive' }],
    selectedEmailIds: new Set(),
    backedUpKeys: null,
    backedUpScopes: null,
    backupConfigured: null,
    setSelection: vi.fn(keys => useMailStoreMock.setState({ selectedEmailIds: new Set(keys) })),
    markSelectedAsRead: vi.fn(async () => useMailStoreMock.setState({ selectedEmailIds: new Set() })),
    markSelectedAsUnread: vi.fn(async () => useMailStoreMock.setState({ selectedEmailIds: new Set() })),
    setSelectedFlagged: vi.fn(async () => useMailStoreMock.setState({ selectedEmailIds: new Set() })),
    purgeSelectedEverywhere: vi.fn(async () => {
      useMailStoreMock.setState({ selectedEmailIds: new Set() });
      return { deleted: 1, failed: 0 };
    }),
    moveEmails: vi.fn().mockResolvedValue(undefined),
  };
  return { ...state, ...overrides };
}

function settingsState(overrides = {}) {
  return {
    emailTemplates: [],
    ...overrides,
  };
}

function tagState(overrides = {}) {
  return {
    tags: [],
    applyTagToRows: vi.fn(async () => true),
    ...overrides,
  };
}

useMailStoreMock = create(() => mailState());
function useMailStore(selector) { return useMailStoreMock(selector); }
useMailStore.getState = () => useMailStoreMock.getState();
vi.mock('../../stores/mailStore', () => ({ useMailStore }));

useSettingsStoreMock = create(() => settingsState());
function useSettingsStore(selector) { return useSettingsStoreMock(selector); }
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore }));

useTagStoreMock = create(() => tagState());
function useTagStore(selector) { return useTagStoreMock(selector); }
useTagStore.getState = () => useTagStoreMock.getState();
vi.mock('../../stores/tagStore', () => ({ useTagStore }));

import { RowQuickActions } from '../RowQuickActions';

function email(overrides = {}) {
  return {
    uid: 42,
    subject: 'A message',
    date: '2026-09-01T10:00:00Z',
    from: { address: 'sender@example.test', name: 'Sender' },
    flags: [],
    isArchived: false,
    source: 'server',
    _accountId: ACCOUNT_A.id,
    _mailbox: 'INBOX',
    ...overrides,
  };
}

function setActions(...entries) {
  mocks.config = { mode: 'inline', palette: 'neutral', entries };
}

function action(action, params = {}) {
  return { id: params.id || action, action, params };
}

function renderActions({ emails = [email()], exportEmails = emails, actions = {}, onRequestDelete = vi.fn(), ...props } = {}) {
  const resolvedActions = {
    deleteEmailFromServer: vi.fn().mockResolvedValue({ uid: 42, trash: 'Trash', trashUid: 142 }),
    removeLocalEmail: vi.fn().mockResolvedValue(undefined),
    removeLocalEmails: vi.fn().mockResolvedValue(undefined),
    saveEmailsLocally: vi.fn().mockResolvedValue(undefined),
    ...actions,
  };
  const view = render(<RowQuickActions emails={emails} exportEmails={exportEmails} actions={resolvedActions}
    onRequestDelete={onRequestDelete} {...props} />);
  return { ...view, actions: resolvedActions, onRequestDelete };
}

beforeEach(() => {
  useMailStoreMock.setState(mailState(), true);
  useSettingsStoreMock.setState(settingsState(), true);
  mocks.config = { mode: 'inline', palette: 'neutral', entries: [] };
  mocks.openCompose.mockReset();
  mocks.openExport.mockReset();
  mocks.replyTarget.mockReset().mockImplementation(async target => ({ uid: target.uid, accountId: target._accountId }));
  mocks.reloadListInView.mockReset().mockResolvedValue(undefined);
  mocks.setDeleteUndo.mockReset();
  mocks.foldersByAccount = {};
});

afterEach(cleanup);

describe('RowQuickActions', () => {
  it.each(['delete', 'deleteServer'])('%s waits for the parent confirmation, then uses explicit row location', async actionName => {
    setActions(action(actionName));
    const target = email({ uid: 7, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const { actions, onRequestDelete } = renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId(`quick-action-${actionName}`));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(actions.deleteEmailFromServer).not.toHaveBeenCalled();

    const [confirm] = onRequestDelete.mock.calls[0];
    await confirm();

    expect(actions.deleteEmailFromServer).toHaveBeenCalledWith(7, {
      accountId: ACCOUNT_B.id, mailboxOverride: 'Sent',
    });
  });

  it('delete everywhere waits for confirmation before scoping the purge to this row', async () => {
    setActions(action('deleteEverywhere'));
    const target = email({ uid: 7, isArchived: true });
    const onRequestDelete = vi.fn();
    renderActions({ emails: [target], onRequestDelete });

    fireEvent.click(screen.getByTestId('quick-action-deleteEverywhere'));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().purgeSelectedEverywhere).not.toHaveBeenCalled();

    const [confirm] = onRequestDelete.mock.calls[0];
    await confirm();

    expect(useMailStore.getState().setSelection).toHaveBeenCalledWith([7]);
    expect(useMailStore.getState().purgeSelectedEverywhere).toHaveBeenCalledTimes(1);
  });

  it('unarchive asks for confirmation before removing the local copy', async () => {
    setActions(action('unarchive'));
    const target = email({ uid: 8, isArchived: true });
    const onRequestDelete = vi.fn();
    const { actions } = renderActions({ emails: [target], onRequestDelete });

    fireEvent.click(screen.getByTestId('quick-action-unarchive'));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(actions.removeLocalEmails).not.toHaveBeenCalled();
    const [confirm] = onRequestDelete.mock.calls[0];
    await confirm();
    expect(actions.removeLocalEmails).toHaveBeenCalledWith([{ uid: 8, location: { accountId: ACCOUNT_A.id, mailbox: 'INBOX' } }]);
    expect(actions.removeLocalEmail).not.toHaveBeenCalled();
  });

  it('preserves unrelated selection around mark-read and star actions', async () => {
    const prior = new Set(['acct-b:INBOX:3']);
    useMailStoreMock.setState({ selectedEmailIds: prior });
    const target = email({ uid: 9 });
    setActions(action('markRead'), action('star'));
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId('quick-action-markRead'));
    await waitFor(() => expect(useMailStore.getState().markSelectedAsRead).toHaveBeenCalledTimes(1));
    expect(useMailStore.getState().selectedEmailIds).toEqual(prior);

    fireEvent.click(screen.getByTestId('quick-action-star'));
    await waitFor(() => expect(useMailStore.getState().setSelectedFlagged).toHaveBeenCalledWith(true));
    expect(useMailStore.getState().selectedEmailIds).toEqual(prior);
  });

  it('exports the supplied complete thread emails', () => {
    const visibleMembers = [email({ uid: 11 })];
    const fullThread = [email({ uid: 10 }), ...visibleMembers];
    setActions(action('export'));
    renderActions({ emails: visibleMembers, exportEmails: fullThread });

    fireEvent.click(screen.getByTestId('quick-action-export'));

    expect(mocks.openExport).toHaveBeenCalledWith({ messages: fullThread });
  });

  it('disables a configured folder or saved template that is no longer available', () => {
    setActions(action('move', { mailbox: 'MissingFolder' }), action('replyTemplate', { templateId: 'gone' }));
    useMailStoreMock.setState({ mailboxes: [{ name: 'INBOX', path: 'INBOX' }] });
    useSettingsStoreMock.setState({ emailTemplates: [] });
    renderActions();

    expect(screen.getByTestId('quick-action-move')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('quick-action-replyTemplate')).toHaveProperty('disabled', true);
  });

  it('opens a reply draft with the selected saved template body', async () => {
    const target = email({ uid: 12, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const replyTo = { uid: 12, accountId: ACCOUNT_B.id };
    setActions(action('replyTemplate', { templateId: 'thanks' }));
    useSettingsStoreMock.setState({ emailTemplates: [{ id: 'thanks', name: 'Thanks', body: '<p>Thank you</p>' }] });
    mocks.replyTarget.mockResolvedValue(replyTo);
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId('quick-action-replyTemplate'));
    await waitFor(() => expect(mocks.openCompose).toHaveBeenCalled());

    expect(mocks.openCompose).toHaveBeenCalledWith({ mode: 'reply', replyTo, templateBody: '<p>Thank you</p>' });
  });

  it('tags the exact account, mailbox, and row', () => {
    const target = email({ uid: 13, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const tag = { id: 'follow-up', name: 'Follow up' };
    setActions(action('tag', { tagId: tag.id }));
    useTagStoreMock.setState({ tags: [tag] });
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId('quick-action-tag'));

    expect(useTagStoreMock.getState().applyTagToRows).toHaveBeenCalledWith(
      [{ email: target, location: { accountId: ACCOUNT_B.id, mailbox: 'Sent' } }],
      tag.id,
    );
  });

  it('gates server deletes but permits a confirmed purge of a local-only vault copy', async () => {
    setActions(action('deleteServer'), action('deleteEverywhere'));
    const readOnly = email({ uid: 14, _insightsReadOnly: true, isArchived: true });
    const { unmount } = renderActions({ emails: [readOnly], onRequestDelete: vi.fn() });
    expect(screen.getByTestId('quick-action-deleteServer')).toHaveProperty('disabled', true);
    unmount();

    const localOnly = email({ uid: 15, source: 'local-only', isArchived: true });
    const { onRequestDelete } = renderActions({ emails: [localOnly] });
    expect(screen.queryByTestId('quick-action-deleteServer')).toBeNull();
    expect(screen.getByTestId('quick-action-deleteEverywhere')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByTestId('quick-action-deleteEverywhere'));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(useMailStoreMock.getState().purgeSelectedEverywhere).not.toHaveBeenCalled();

    await onRequestDelete.mock.calls[0][0]();
    expect(useMailStoreMock.getState().purgeSelectedEverywhere).toHaveBeenCalledTimes(1);
  });

  it('keeps same-UID server deletes scoped to each account and mailbox', async () => {
    const first = email({ uid: 20, _accountId: ACCOUNT_A.id, _mailbox: 'INBOX' });
    const second = email({ uid: 20, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    useMailStoreMock.setState({ activeMailbox: 'UNIFIED', unifiedInbox: true });
    setActions(action('deleteServer'));
    const { actions, onRequestDelete } = renderActions({ emails: [first, second] });

    fireEvent.click(screen.getByTestId('quick-action-deleteServer'));
    expect(actions.deleteEmailFromServer).not.toHaveBeenCalled();
    await onRequestDelete.mock.calls[0][0]();

    expect(actions.deleteEmailFromServer).toHaveBeenNthCalledWith(1, 20, {
      skipRefresh: true, accountId: ACCOUNT_A.id, mailboxOverride: 'INBOX',
    });
    expect(actions.deleteEmailFromServer).toHaveBeenNthCalledWith(2, 20, {
      skipRefresh: true, accountId: ACCOUNT_B.id, mailboxOverride: 'Sent',
    });
  });

  it('unarchives same-UID copies using each exact account and mailbox', async () => {
    const first = email({ uid: 21, isArchived: true, _accountId: ACCOUNT_A.id, _mailbox: 'INBOX' });
    const second = email({ uid: 21, isArchived: true, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    useMailStoreMock.setState({ activeMailbox: 'UNIFIED', unifiedInbox: true });
    setActions(action('unarchive'));
    const { actions, onRequestDelete } = renderActions({ emails: [first, second] });

    fireEvent.click(screen.getByTestId('quick-action-unarchive'));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(onRequestDelete).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      title: 'viewer.unarchiveEmail', confirmLabel: 'rowMenu.unarchive',
    }));
    expect(actions.removeLocalEmails).not.toHaveBeenCalled();
    await onRequestDelete.mock.calls[0][0]();
    // One batched call; each copy keeps its own exact location.
    await waitFor(() => expect(actions.removeLocalEmails).toHaveBeenCalledTimes(1));
    expect(actions.removeLocalEmails).toHaveBeenCalledWith([
      { uid: 21, location: { accountId: ACCOUNT_A.id, mailbox: 'INBOX' } },
      { uid: 21, location: { accountId: ACCOUNT_B.id, mailbox: 'Sent' } },
    ]);
  });
});
