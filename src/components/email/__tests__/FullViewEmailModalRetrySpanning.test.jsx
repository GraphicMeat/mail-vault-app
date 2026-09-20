// @vitest-environment jsdom

// Bug report (2026-09-14): FullViewEmailModal's initial-fetch effect called
// `selectEmail(initialEmail.uid, initialEmail.source || 'server')` - a bare
// uid. In a spanning view (All Inboxes, a folder branch) `requireUnifiedContext`
// refuses that and the modal never gets its body, exactly the same defect as
// EmailViewer's retry button (EmailViewerRetrySpanning.test.jsx). The fix
// reads the row's own `_accountId`/`_mailbox` the way EmailRow's `openRow`
// does, and only in a spanning view.
//
// Rendered with the real stores (mocks limited to the virtualizer and body
// loader), same pattern as emailPalette.test.jsx: what matters here is the
// exact first argument the effect hands to `selectEmail`.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMailStore } from '../../../stores/mailStore';
import { useThemeStore } from '../../../stores/themeStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { FullViewEmailModal } from '../FullViewEmailModal';
import { cancelSelection, getSelectionGeneration, selectEmail as realSelectEmail } from '../../../services/workflows/selectEmail';

const actionMutations = vi.hoisted(() => ({
  applyFlagToKeys: vi.fn().mockResolvedValue(undefined),
  purgeEverywhere: vi.fn().mockResolvedValue({ deleted: 1, failed: 0 }),
}));
vi.mock('../../../services/workflows/messageMutations', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual,
    applyFlagToKeys: (...args) => actionMutations.applyFlagToKeys(...args),
    purgeEverywhere: (...args) => actionMutations.purgeEverywhere(...args),
  };
});

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});
vi.mock('../../QuickActions', () => ({
  QuickActions: ({ descriptors = [] }) => React.createElement('div', null,
    descriptors.map(descriptor => React.createElement('button', {
      key: descriptor.id,
      type: 'button',
      'data-testid': `reader-action-${descriptor.action}`,
      disabled: descriptor.disabled,
      ref: descriptor.buttonRef,
      onClick: () => { void descriptor.onActivate?.(); },
    }, descriptor.label))),
}));
vi.mock('../../MoveToFolderDropdown', () => ({
  MoveToFolderDropdown: ({ accountId, currentMailbox, onMove }) => React.createElement('div', {
    'data-testid': 'reader-move-dropdown',
    'data-account-id': accountId,
    'data-current-mailbox': currentMailbox,
  }, React.createElement('button', { type: 'button', 'data-testid': 'move-to-archive', onClick: () => onMove('Archive') }, 'Move to Archive')),
}));

// No html/text: fails the modal's `hasContent` check, so the mount effect
// runs `selectEmail(initialEmail.uid, initialEmail.source || 'server')`.
const initialEmail = {
  uid: 282, _accountId: 'acct-1', _mailbox: 'Sent', source: 'local', subject: 'didelis laiskas',
  from: { name: 'Sender', address: 'sender@example.test' }, to: [{ address: 'me@example.test' }],
  attachments: [], flags: [], date: '2026-09-07',
};

function renderModal(mockSelectEmail, onClose = () => {}, email = initialEmail, storeOverrides = {}) {
  useThemeStore.setState({ palette: 'graphite', theme: 'dark' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'sender@example.test' }],
    activeAccountId: 'acct-1',
    selectedEmail: null,
    selectedThread: null,
    loadingEmail: false,
    selectedEmailSource: null,
    emails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    ...storeOverrides,
    selectEmail: mockSelectEmail,
  });
  return render(<FullViewEmailModal email={email} onClose={onClose} />);
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useSettingsStore.getState().resetQuickActions();
  actionMutations.applyFlagToKeys.mockReset().mockResolvedValue(undefined);
  actionMutations.purgeEverywhere.mockReset().mockResolvedValue({ deleted: 1, failed: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('FullViewEmailModal initial fetch, spanning vs. single-folder', () => {
  it('sends the full selection key in a spanning view (All Inboxes)', () => {
    const mockSelectEmail = vi.fn();
    useMailStore.setState({ activeMailbox: 'UNIFIED', mailboxScope: null });
    renderModal(mockSelectEmail);

    expect(mockSelectEmail).toHaveBeenCalledTimes(1);
    expect(mockSelectEmail.mock.calls[0][0]).toBe('acct-1:Sent:282');
    expect(mockSelectEmail.mock.calls[0][1]).toBe('local');
  });

  it('keeps sending the bare uid in a single-folder view (unchanged today)', () => {
    const mockSelectEmail = vi.fn();
    useMailStore.setState({ activeMailbox: 'INBOX', mailboxScope: null });
    renderModal(mockSelectEmail);

    expect(mockSelectEmail).toHaveBeenCalledTimes(1);
    expect(mockSelectEmail.mock.calls[0][0]).toBe(282);
    expect(mockSelectEmail.mock.calls[0][1]).toBe('local');
  });

  it('does not cancel a newer reader when a preloaded modal closes', () => {
    const loaded = { ...initialEmail, html: '<p>already loaded</p>' };
    useMailStore.setState({ activeMailbox: 'INBOX', mailboxScope: null });
    const view = renderModal(vi.fn(), vi.fn(), loaded);

    // The modal never started a selection for a preloaded body. A newer reader
    // may therefore own the current generation when this modal closes.
    cancelSelection();
    useMailStore.setState({ selectedEmailId: 999, selectedEmail: { uid: 999, subject: 'New reader' }, loadingEmail: true });
    const currentGeneration = getSelectionGeneration();
    fireEvent.click(view.getByRole('button', { name: 'Close', exact: true }));

    expect(getSelectionGeneration()).toBe(currentGeneration);
  });

  it('clears loading for its own pending body fetch on close', async () => {
    const api = await import('../../../services/api');
    const db = await import('../../../services/db');
    const auth = await import('../../../services/authUtils');
    let release;
    vi.spyOn(auth, 'ensureFreshToken').mockImplementation(async account => account);
    vi.spyOn(db, 'getLocalEmailLight').mockResolvedValue(null);
    vi.spyOn(api, 'fetchEmailLight').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    useMailStore.setState({ activeMailbox: 'Sent', mailboxScope: null, emailCache: new Map() });
    const view = renderModal(realSelectEmail);
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(useMailStore.getState().loadingEmail).toBe(true);

    fireEvent.click(view.getByRole('button', { name: 'Close', exact: true }));
    expect(useMailStore.getState().loadingEmail).toBe(false);
    release({ ...initialEmail, html: '<p>body</p>' });
    await Promise.resolve();
  });

  it('closes its own selection before the body request publishes an ID', async () => {
    const auth = await import('../../../services/authUtils');
    let releaseToken;
    vi.spyOn(auth, 'ensureFreshToken').mockImplementation(() => new Promise(resolve => { releaseToken = resolve; }));
    useMailStore.setState({ activeMailbox: 'Sent', mailboxScope: null, emailCache: new Map() });
    const view = renderModal(realSelectEmail);
    await waitFor(() => expect(releaseToken).toBeTypeOf('function'));

    fireEvent.click(view.getByRole('button', { name: 'Close', exact: true }));
    expect(useMailStore.getState().loadingEmail).toBe(false);
    releaseToken({ id: 'acct-1', email: 'sender@example.test' });
    await Promise.resolve();
    expect(useMailStore.getState().selectedEmailId).toBeNull();
  });
});

const readerAction = (action, params = {}) => ({ id: action, action, params });

function configureReaderActions(...entries) {
  useSettingsStore.getState().setQuickActionSurface('reader', null, {
    mode: 'inline', entries, favoriteId: entries[0]?.id || null, palette: 'neutral',
  });
}

async function confirmDelete() {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getAllByRole('button').at(-1));
}

describe('FullViewEmailModal actions', () => {
  const ACCOUNT_A = { id: 'acct-a', email: 'a@example.test' };
  const ACCOUNT_B = { id: 'acct-b', email: 'b@example.test' };
  const fullMessage = (overrides = {}) => ({
    ...initialEmail, html: '<p>body</p>', source: 'server', _accountId: ACCOUNT_A.id, _mailbox: 'INBOX', ...overrides,
  });
  const spanningState = overrides => ({
    accounts: [ACCOUNT_A, ACCOUNT_B], activeAccountId: ACCOUNT_A.id, activeMailbox: 'UNIFIED',
    unifiedInbox: true, unifiedFolder: 'INBOX', mailboxScope: null, ...overrides,
  });

  it('requests delete confirmation and executes a raw UID with the captured account and mailbox', async () => {
    configureReaderActions(readerAction('delete'));
    const target = fullMessage({ uid: 73, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const deleteEmailFromServer = vi.fn().mockResolvedValue(undefined);
    renderModal(vi.fn(), vi.fn(), target, spanningState({ deleteEmailFromServer }));

    fireEvent.click(screen.getByTestId('reader-action-delete'));
    expect(deleteEmailFromServer).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('alertdialog');
    expect(document.body.contains(confirm)).toBe(true);
    await confirmDelete();
    await waitFor(() => expect(deleteEmailFromServer).toHaveBeenCalledWith(73, {
      accountId: ACCOUNT_B.id, mailboxOverride: 'Sent',
    }));
  });

  it('does not hydrate or delete a same-UID reader from another account and folder', async () => {
    configureReaderActions(readerAction('delete'));
    const target = fullMessage({ uid: 74, subject: 'Account A copy', _accountId: ACCOUNT_A.id, _mailbox: 'INBOX' });
    const selectedFromOtherLocation = fullMessage({ uid: 74, subject: 'Account B copy', _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const deleteEmailFromServer = vi.fn().mockResolvedValue(undefined);
    renderModal(vi.fn(), vi.fn(), target, spanningState({ selectedEmail: selectedFromOtherLocation, deleteEmailFromServer }));

    expect(screen.getByRole('heading', { name: 'Account A copy' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Account B copy' })).toBeNull();
    fireEvent.click(screen.getByTestId('reader-action-delete'));
    await confirmDelete();

    await waitFor(() => expect(deleteEmailFromServer).toHaveBeenCalledWith(74, {
      accountId: ACCOUNT_A.id, mailboxOverride: 'INBOX',
    }));
  });

  it('honors the configured mark-unread direction when the renderer passes an entry object', async () => {
    configureReaderActions(readerAction('markUnread'));
    const target = fullMessage({ uid: 82, flags: ['\\Seen'], _accountId: ACCOUNT_A.id, _mailbox: 'INBOX' });
    renderModal(vi.fn(), vi.fn(), target, spanningState({}));

    fireEvent.click(screen.getByTestId('reader-action-markUnread'));

    await waitFor(() => expect(actionMutations.applyFlagToKeys).toHaveBeenCalledWith(
      [`${ACCOUNT_A.id}:INBOX:82`], '\\Seen', false,
    ));
  });

  it('does not restore an old selection after a confirmed purge finishes', async () => {
    configureReaderActions(readerAction('deleteEverywhere'));
    const target = fullMessage({ uid: 83, isArchived: true, _accountId: ACCOUNT_A.id, _mailbox: 'INBOX' });
    const view = renderModal(vi.fn(), vi.fn(), target, spanningState({
      backedUpKeys: new Set([`${ACCOUNT_A.id}:INBOX:83`]),
      backedUpScopes: new Set([`${ACCOUNT_A.id}:INBOX`]), backupConfigured: true,
      selectedEmailIds: new Set(['old-selection']),
    }));
    let releasePurge;
    actionMutations.purgeEverywhere.mockImplementationOnce(() => new Promise(resolve => { releasePurge = resolve; }));

    fireEvent.click(view.getByTestId('reader-action-deleteEverywhere'));
    await confirmDelete();
    await waitFor(() => expect(actionMutations.purgeEverywhere).toHaveBeenCalledWith(['acct-a:INBOX:83']));
    useMailStore.setState({ selectedEmailIds: new Set(['new-selection']) });
    releasePurge({ deleted: 1, failed: 0 });

    await waitFor(() => expect(useMailStore.getState().selectedEmailIds).toEqual(new Set(['new-selection'])));
  });

  it('clears the previous fetched body when the initial target identity changes', async () => {
    configureReaderActions(readerAction('delete'));
    const first = fullMessage({ uid: 75, subject: 'First body', _accountId: ACCOUNT_A.id, _mailbox: 'INBOX' });
    const second = fullMessage({ uid: 75, subject: 'Second body', _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const props = spanningState({});
    const view = renderModal(vi.fn(), vi.fn(), first, props);

    view.rerender(<FullViewEmailModal email={second} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Second body' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'First body' })).toBeNull();
  });

  it('uses backup scope/configuration before offering Delete everywhere', () => {
    configureReaderActions(readerAction('deleteEverywhere'));
    const target = fullMessage({ uid: 76, isArchived: false, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const key = `${ACCOUNT_B.id}:Sent:76`;
    renderModal(vi.fn(), vi.fn(), target, spanningState({
      backedUpKeys: new Set([key]), backedUpScopes: new Set([`${ACCOUNT_B.id}:Sent`]), backupConfigured: false,
    }));

    expect(screen.queryByTestId('reader-action-deleteEverywhere')).toBeNull();
  });

  it('offers backup-backed purge and waits for its portal confirmation', async () => {
    configureReaderActions(readerAction('deleteEverywhere'));
    const target = fullMessage({ uid: 77, isArchived: false, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const key = `${ACCOUNT_B.id}:Sent:77`;
    const view = renderModal(vi.fn(), vi.fn(), target, spanningState({
      backedUpKeys: new Set([key]), backedUpScopes: new Set([`${ACCOUNT_B.id}:Sent`]), backupConfigured: true,
      selectedEmailIds: new Set(['unrelated']),
    }));

    fireEvent.click(view.getByTestId('reader-action-deleteEverywhere'));
    expect(actionMutations.purgeEverywhere).not.toHaveBeenCalled();
    await confirmDelete();
    await waitFor(() => expect(actionMutations.purgeEverywhere).toHaveBeenCalledWith([key]));
    expect(useMailStore.getState().selectedEmailIds).toEqual(new Set(['unrelated']));
  });

  it('confirms a scoped unarchive and gives the move picker the actual location', async () => {
    configureReaderActions(readerAction('unarchive'), readerAction('move'));
    const target = fullMessage({ uid: 78, isArchived: true, _accountId: ACCOUNT_B.id, _mailbox: 'Sent' });
    const removeLocalEmail = vi.fn().mockResolvedValue(undefined);
    const moveEmails = vi.fn().mockResolvedValue(undefined);
    renderModal(vi.fn(), vi.fn(), target, spanningState({ removeLocalEmail, moveEmails }));

    fireEvent.click(screen.getByTestId('reader-action-unarchive'));
    await confirmDelete();
    await waitFor(() => expect(removeLocalEmail).toHaveBeenCalledWith(78, { accountId: ACCOUNT_B.id, mailbox: 'Sent' }));

    fireEvent.click(screen.getByTestId('reader-action-move'));
    const picker = await screen.findByTestId('reader-move-dropdown');
    expect(picker.getAttribute('data-account-id')).toBe(ACCOUNT_B.id);
    expect(picker.getAttribute('data-current-mailbox')).toBe('Sent');
    fireEvent.click(screen.getByTestId('move-to-archive'));
    expect(moveEmails).toHaveBeenCalledWith([`${ACCOUNT_B.id}:Sent:78`], 'Archive');
  });

  it('hides server mutation actions for insight read-only and local-only messages', () => {
    configureReaderActions(readerAction('deleteServer'), readerAction('deleteEverywhere'), readerAction('archive'), readerAction('markRead'), readerAction('move'));
    const readOnly = fullMessage({ uid: 79, _insightsReadOnly: true });
    const first = renderModal(vi.fn(), vi.fn(), readOnly, spanningState({}));
    for (const action of ['deleteServer', 'deleteEverywhere', 'archive', 'markRead', 'move']) {
      expect(screen.queryByTestId(`reader-action-${action}`)).toBeNull();
    }
    first.unmount();

    const localOnly = fullMessage({ uid: 80, source: 'local-only', isArchived: true });
    renderModal(vi.fn(), vi.fn(), localOnly, spanningState({}));
    expect(screen.queryByTestId('reader-action-deleteServer')).toBeNull();
    expect(screen.queryByTestId('reader-action-archive')).not.toBeNull();
  });
});
