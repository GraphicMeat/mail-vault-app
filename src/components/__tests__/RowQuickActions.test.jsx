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
  QuickActions: ({ descriptors = [], onOpenChange }) => React.createElement('div', null,
    React.createElement('button', { key: '__open', 'data-testid': 'menu-open', onClick: () => onOpenChange?.(true) }),
    React.createElement('button', { key: '__close', 'data-testid': 'menu-close', onClick: () => onOpenChange?.(false) }),
    ...descriptors.filter(descriptor => !descriptor.hidden).map(descriptor => React.createElement('button', {
      key: descriptor.id,
      type: 'button',
      'data-testid': `quick-action-${descriptor.id}`,
      'data-action': descriptor.action,
      disabled: descriptor.disabled,
      onClick: event => { void descriptor.onActivate?.(event); },
    }, descriptor.Icon && React.createElement(descriptor.Icon), descriptor.label))),
}));

vi.mock('../MoveToFolderDropdown', () => ({
  MoveToFolderDropdown: ({ onClose }) => React.createElement('button', { 'data-testid': 'move-dropdown', onClick: onClose }),
}));
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

  it('opens reply on the header immediately, then hands in the resolved body', async () => {
    const target = email({ uid: 14, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const resolved = { uid: 14, accountId: ACCOUNT_B.id };
    let resolveBody;
    mocks.replyTarget.mockReturnValue(new Promise(resolve => { resolveBody = resolve; }));
    setActions(action('reply'));
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId('quick-action-reply'));

    // No await between the click and this assertion: the wheel must not
    // wait on replyTarget's fetch before compose appears.
    expect(mocks.openCompose).toHaveBeenCalledTimes(1);
    expect(mocks.openCompose).toHaveBeenCalledWith({ mode: 'reply', replyTo: target });

    resolveBody(resolved);
    await waitFor(() => expect(mocks.openCompose).toHaveBeenCalledTimes(2));
    expect(mocks.openCompose).toHaveBeenLastCalledWith({ mode: 'reply', replyTo: resolved, _fillFrom: target });
  });

  it('does not send a fill-in call when the body resolve fails and hands back the same header', async () => {
    const target = email({ uid: 16, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    mocks.replyTarget.mockImplementation(async header => header);
    setActions(action('reply'));
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId('quick-action-reply'));
    await waitFor(() => expect(mocks.openCompose).toHaveBeenCalledTimes(1));

    // Give the resolved-but-unchanged promise a tick to settle, then confirm
    // no second call ever came.
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.openCompose).toHaveBeenCalledTimes(1);
  });

  // A compose window of its own takes the draft as it stands when it opens
  // and never gets the later fill-in (utils/sameReply.js), so with Compose set
  // to open in one a reply waits for the body the way a forward does.
  it.each(['reply', 'replyAll'])('waits for the body before opening a %s in a window of its own', async mode => {
    useSettingsStoreMock.setState({ composeOpenMode: 'window' });
    const target = email({ uid: 17, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const resolved = { uid: 17, accountId: ACCOUNT_B.id, html: '<p>Body</p>' };
    let resolveBody;
    mocks.replyTarget.mockReturnValue(new Promise(resolve => { resolveBody = resolve; }));
    setActions(action(mode));
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId(`quick-action-${mode}`));
    expect(mocks.openCompose).not.toHaveBeenCalled();

    resolveBody(resolved);
    await waitFor(() => expect(mocks.openCompose).toHaveBeenCalled());
    expect(mocks.openCompose).toHaveBeenCalledTimes(1);
    expect(mocks.openCompose).toHaveBeenCalledWith({ mode, replyTo: resolved });
  });

  it('waits for the body before opening a forward, which inlines it into the message', async () => {
    const target = email({ uid: 15, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const resolved = { uid: 15, accountId: ACCOUNT_B.id };
    mocks.replyTarget.mockResolvedValue(resolved);
    setActions(action('forward'));
    renderActions({ emails: [target] });

    fireEvent.click(screen.getByTestId('quick-action-forward'));

    await waitFor(() => expect(mocks.openCompose).toHaveBeenCalled());
    expect(mocks.openCompose).toHaveBeenCalledTimes(1);
    expect(mocks.openCompose).toHaveBeenCalledWith({ mode: 'forward', replyTo: resolved });
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

  it('offers no purge on a message only the server holds', () => {
    // Nothing of our own to clear: the item would only repeat "Delete from
    // server" under a name that claims the vault and backup too.
    setActions(action('deleteServer'), action('deleteEverywhere'));
    renderActions({ emails: [email({ uid: 16 })], onRequestDelete: vi.fn() });
    expect(screen.getByTestId('quick-action-deleteServer')).toBeTruthy();
    expect(screen.queryByTestId('quick-action-deleteEverywhere')).toBeNull();
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

// The row mounts RowQuickActions only while it is live, and a pointer that
// leaves it would unmount an open menu or the folder picker a menu action
// opened. So the row hears when either is up and holds itself live meanwhile.
describe('RowQuickActions busy', () => {
  it('reports busy while its menu or a follow-up picker is open, and idle once both are gone', () => {
    setActions(action('move'));
    const onBusyChange = vi.fn();
    renderActions({ onBusyChange });
    expect(onBusyChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('menu-open'));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    // Picking Move closes the menu before the picker opens: still busy.
    fireEvent.click(screen.getByTestId('quick-action-move'));
    fireEvent.click(screen.getByTestId('menu-close'));
    expect(screen.getByTestId('move-dropdown')).toBeTruthy();
    expect(onBusyChange).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('move-dropdown'));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(onBusyChange).toHaveBeenCalledTimes(2);
  });
});

// A right-click inside a multi-selection acts on the whole selection, so the
// row menu can be handed several emails at once — "mixed" is a real case
// here, not just a selection-bar concern.
describe('RowQuickActions — read/star/archive visibility', () => {
  it('hides mark read on an all-read target, and mark unread on an all-unread one', () => {
    setActions(action('markRead'), action('markUnread'));
    renderActions({ emails: [email({ flags: ['\\Seen'] })] });
    expect(screen.queryByTestId('quick-action-markRead')).toBeNull();
    expect(screen.getByTestId('quick-action-markUnread')).toBeTruthy();
  });

  it('shows both mark read and mark unread for a mixed selection', () => {
    setActions(action('markRead'), action('markUnread'));
    renderActions({ emails: [email({ flags: ['\\Seen'] }), email({ uid: 99 })] });
    expect(screen.getByTestId('quick-action-markRead')).toBeTruthy();
    expect(screen.getByTestId('quick-action-markUnread')).toBeTruthy();
  });

  it('hides star once every target is already flagged, and unstar once none are', () => {
    setActions(action('star'), action('unstar'));
    renderActions({ emails: [email({ flags: ['\\Flagged'] })] });
    expect(screen.queryByTestId('quick-action-star')).toBeNull();
    expect(screen.getByTestId('quick-action-unstar')).toBeTruthy();
  });

  it('hides archive on an already-archived target, and unarchive on one that is not', () => {
    setActions(action('archive'), action('unarchive'));
    renderActions({ emails: [email({ isArchived: true })], onRequestDelete: vi.fn() });
    expect(screen.queryByTestId('quick-action-archive')).toBeNull();
    expect(screen.getByTestId('quick-action-unarchive')).toBeTruthy();
  });
});

// The radial toggle's glyph was pinned to the open envelope, so an already
// read row showed "Mark unread" under the icon for marking read.
describe('RowQuickActions — toggle read', () => {
  const icon = testId => screen.getByTestId(testId).querySelector('[data-icon]')?.dataset.icon;

  it('shows the envelope of the direction it will take', () => {
    setActions(action('toggleRead'));
    renderActions({ emails: [email()] });
    expect(screen.getByTestId('quick-action-toggleRead').textContent).toBe('rowMenu.markRead');
    expect(icon('quick-action-toggleRead')).toBe('MailOpen');
    cleanup();
    renderActions({ emails: [email({ flags: ['\\Seen'] })] });
    expect(screen.getByTestId('quick-action-toggleRead').textContent).toBe('rowMenu.markUnread');
    expect(icon('quick-action-toggleRead')).toBe('Mail');
  });

  it('offers both directions on a thread, whatever its members read state', async () => {
    setActions(action('toggleRead'));
    const thread = [email({ uid: 1, flags: ['\\Seen'] }), email({ uid: 2, flags: ['\\Seen'] })];
    renderActions({ emails: thread });
    expect(screen.queryByTestId('quick-action-toggleRead')).toBeNull();
    expect(icon('quick-action-toggleRead:markRead')).toBe('MailOpen');
    expect(icon('quick-action-toggleRead:markUnread')).toBe('Mail');
    fireEvent.click(screen.getByTestId('quick-action-toggleRead:markUnread'));
    await waitFor(() => expect(useMailStoreMock.getState().markSelectedAsUnread).toHaveBeenCalledTimes(1));
    expect(useMailStoreMock.getState().markSelectedAsRead).not.toHaveBeenCalled();
  });
});

describe('RowQuickActions unsubscribe', () => {
  it('shows only on a row carrying List-Unsubscribe and asks through the shared dialog', async () => {
    const { useUnsubscribeStore } = await import('../../stores/unsubscribeStore');
    useUnsubscribeStore.setState({ pending: null });
    setActions(action('unsubscribe'));
    renderActions({ emails: [email()] });
    expect(screen.queryByTestId('quick-action-unsubscribe')).toBeNull();
    cleanup();

    const list = email({
      uid: 8, _accountId: ACCOUNT_B.id, listUnsubscribe: '<https://list.test/u>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click', authenticationResults: 'mx.test; dkim=pass',
    });
    // A thread row: the older message carries no list headers.
    renderActions({ emails: [email({ uid: 3, date: '2026-08-01T10:00:00Z' }), list] });
    fireEvent.click(screen.getByTestId('quick-action-unsubscribe'));
    expect(useUnsubscribeStore.getState().pending).toEqual({
      accountId: ACCOUNT_B.id, sender: 'sender@example.test', name: 'Sender',
      listUnsubscribe: '<https://list.test/u>', listUnsubscribePost: 'List-Unsubscribe=One-Click',
      authenticationResults: 'mx.test; dkim=pass',
    });
  });
});

// A row of a vault-only folder (MBOX import mode 3). No server holds that
// folder: move, spam and snooze need one, delete everywhere and unarchive
// would remove the only copy with no bin copy kept. Delete is the plain delete
// into the deleted bin (the delete workflow routes it there), said as such.
describe('RowQuickActions — a row in a folder kept on this computer', () => {
  const LOCAL = 'MBOX import 2026-09-29';
  const localRow = () => email({ uid: 9, _mailbox: LOCAL, isArchived: true, source: 'local', messageId: '<imported@example.test>', flags: ['\\Seen'] });
  const button = id => screen.queryByTestId(`quick-action-${id}`);
  beforeEach(() => {
    useMailStoreMock.setState({
      localFolders: { [ACCOUNT_A.id]: [{ name: LOCAL, dir: 'MBOX_import_2026-09-29', kind: 'import' }] },
      mailboxes: [{ name: 'Junk', path: 'Junk', specialUse: '\\Junk' }],
    });
  });

  it('offers no server action and nothing that skips the bin, and keeps read, star and export', () => {
    setActions(...['move', 'spam', 'snooze', 'deleteEverywhere', 'unarchive', 'toggleRead', 'star', 'export'].map(name => action(name)));
    renderActions({ emails: [localRow()] });
    for (const id of ['move', 'spam', 'snooze']) expect(button(id) === null || button(id).disabled).toBe(true);
    for (const id of ['deleteEverywhere', 'unarchive']) expect(button(id)).toBeNull();
    for (const id of ['toggleRead', 'star', 'export']) expect(button(id).disabled).toBe(false);
  });

  it('control: the same row in a server folder is offered them', () => {
    setActions(...['move', 'spam', 'snooze', 'deleteEverywhere', 'unarchive'].map(name => action(name)));
    renderActions({ emails: [{ ...localRow(), _mailbox: 'INBOX' }] });
    for (const id of ['move', 'spam', 'snooze', 'deleteEverywhere', 'unarchive']) expect(button(id).disabled).toBe(false);
  });

  it.each(['delete', 'deleteServer'])('%s is a plain delete into the deleted bin, confirmed first', async name => {
    setActions(action(name));
    const { actions, onRequestDelete } = renderActions({ emails: [localRow()] });
    const btn = button(name);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('common.delete');

    fireEvent.click(btn);
    const [confirm, copy] = onRequestDelete.mock.calls[0];
    expect(copy).toMatchObject({ title: 'viewer.deleteEmail', description: 'viewer.localFolderDeleteToBin', confirmLabel: 'common.delete' });
    await confirm();
    expect(actions.deleteEmailFromServer).toHaveBeenCalledWith(9, { accountId: ACCOUNT_A.id, mailboxOverride: LOCAL });
    expect(actions.removeLocalEmails).not.toHaveBeenCalled();
  });
});
