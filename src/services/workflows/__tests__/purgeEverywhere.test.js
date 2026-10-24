// Presentation replacement for decisions now covered by the native42-case oracle.
import { it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../rowVerdicts', async (original) => ({
  ...(await original()),
  annotateRowAlerts: (rows) => rows,
}));
const native = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../../BulkOperationManager.js', async (original) => ({
  ...(await original()),
  bulkOperationManager: { start: (...a) => native.start(...a) },
}));
import {
  ACCOUNT,
  prime,
  serverMsg,
  useMailStore,
  purgeEverywhere,
  purgeEverywhereReporting,
  mockDeleteEmail,
  mockMaildirDeleteMany,
  mockBackupPurgeUids,
  mockSaveEmailHeaders,
  mockRemoveSearchResults,
  mockGetEmailHeadersMeta,
  setDeleteUndo,
  mockMoveEmails,
  mockSearch,
} from './purgeEverywhereHarness';
import { captureBulkScope } from '../../bulkSelection.js';
import { captureSelectionSnapshot } from '../../headerIdentity.js';
const row = (uid) => ({
  ...serverMsg(uid),
  _nativeIdentity: {
    accountId: ACCOUNT.id,
    mailbox: 'INBOX.Spam',
    uidValidity: 1,
    originHash: 'A',
  },
});
const refused = (hint) => ({
  accountId: hint.accountId,
  mailbox: hint.mailbox,
  uid: hint.uid,
  proof: null,
  refused: true,
  skipped: false,
  server: 'pending',
  local: 'pending',
  mirror: 'pending',
});
function outcome(scope, fail = false) {
  return {
    status: 'complete',
    result: {
      deleted: fail ? 0 : scope.keys.length,
      failed: fail ? scope.keys.length : 0,
      queuedBackup: 0,
      needsResync: 0,
    },
    outcomes: scope.targetHints.map((hint) => ({
      hint,
      target: fail
        ? refused(hint)
        : {
            ...refused(hint),
            refused: false,
            proof: { kind: 'server' },
            server: 'complete',
            local: 'complete',
          },
    })),
  };
}
beforeEach(() => {
  native.start
    .mockReset()
    .mockImplementation(async ({ scope }) => outcome(scope));
  prime({ emails: [row(1), row(2)] });
  useMailStore.setState({
    selectedEmailSnapshots: new Map(),
    selectedEmailIds: new Set(),
    error: null,
    undo: null,
    mailboxScope: null,
    localFolders: {},
  });
});
it('starts once with original hints and leaves all mail decisions native', async () => {
  const result = await purgeEverywhere([1]);
  expect(result.deleted).toBe(1);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(native.start.mock.calls[0][0].scope.targetHints[0]).toMatchObject({
    uid: 1,
    messageId: 'm1@mock',
    nativeIdentity: { originHash: 'A' },
  });
  expect(mockDeleteEmail).not.toHaveBeenCalled();
  expect(mockMaildirDeleteMany).not.toHaveBeenCalled();
  expect(mockBackupPurgeUids).not.toHaveBeenCalled();
  expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
});
it('restores the exact refused optimistic row and lifts its tombstone', async () => {
  native.start.mockImplementation(async ({ scope }) => outcome(scope, true));
  await purgeEverywhere([1]);
  expect(
    useMailStore
      .getState()
      .emails.map((e) => e.uid)
      .sort()
  ).toEqual([1, 2]);
  expect(useMailStore.getState().deleteTombstones.size).toBe(0);
});
it('refreshes and restores conservatively when A outcomes were replaced by B', async () => {
  native.start.mockResolvedValue({
    status: 'complete',
    result: { deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 },
    outcomes: [],
  });
  await purgeEverywhere([1]);
  expect(useMailStore.getState().emails.some((e) => e.uid === 1)).toBe(true);
  expect(useMailStore.getState().loadEmails).toHaveBeenCalled();
});
it('does not restore original A over a new original identity under the same key', async () => {
  native.start.mockImplementation(async ({ scope }) => {
    useMailStore.setState({
      emails: [
        {
          ...row(1),
          messageId: 'B',
          _nativeIdentity: { ...row(1)._nativeIdentity, originHash: 'B' },
        },
      ],
    });
    return outcome(scope, true);
  });
  await purgeEverywhere([1]);
  expect(useMailStore.getState().emails.map((e) => e.messageId)).toEqual(['B']);
  expect(useMailStore.getState().deleteTombstones.size).toBe(0);
});
it('keeps a fresh tick made during the awaited operation', async () => {
  native.start.mockImplementation(async ({ scope }) => {
    useMailStore.getState().toggleEmailSelection(2);
    return outcome(scope);
  });
  await purgeEverywhere([1]);
  expect([...useMailStore.getState().selectedEmailIds]).toEqual([2]);
});
it('preserves offscreen original companions without borrowing a later cache row', async () => {
  const hint = captureSelectionSnapshot(row(1), ACCOUNT.id, 'INBOX.Spam');
  useMailStore.setState({
    emails: [],
    selectedEmailIds: new Set([1]),
    selectedEmailSnapshots: new Map([[1, hint]]),
  });
  await purgeEverywhere([1]);
  expect(native.start.mock.calls[0][0].scope.targetHints).toEqual([hint]);
});
it('freezes clicked proof before any Undo or async preparation', async () => {
  const scope = captureBulkScope([1], useMailStore.getState(), [row(1)]);
  useMailStore.setState({ emails: [{ ...row(1), messageId: 'B' }] });
  await purgeEverywhere([1], { scope });
  expect(native.start.mock.calls[0][0].scope.targetHints[0].messageId).toBe(
    'm1@mock'
  );
  expect(useMailStore.getState().emails[0].messageId).toBe('B');
});
it('does not overwrite another view or cache after a switched account', async () => {
  native.start.mockImplementation(async ({ scope }) => {
    useMailStore.setState({
      activeAccountId: 'B',
      activeMailbox: 'Sent',
      emails: [{ uid: 1, messageId: 'B' }],
      savedEmailIds: new Set([9]),
      totalEmails: 1,
    });
    return outcome(scope, true);
  });
  await purgeEverywhere([1]);
  expect(useMailStore.getState().emails).toMatchObject([
    { uid: 1, messageId: 'B' },
  ]);
  expect([...useMailStore.getState().savedEmailIds]).toEqual([9]);
  expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
});
it('closes the matching reader and prunes exact search scopes', async () => {
  useMailStore.setState({
    selectedEmail: row(1),
    selectedEmailId: 1,
    selectedThread: null,
  });
  await purgeEverywhere([1]);
  expect(useMailStore.getState().selectedEmailId).not.toBe(1);
  expect(mockRemoveSearchResults).toHaveBeenCalledWith([
    `${ACCOUNT.id}|INBOX.Spam|1`,
  ]);
});
it('clears Undo and reports four partial counters as warning, clean success silently', async () => {
  useMailStore.setState({ undo: { canUndo: true } });
  await purgeEverywhereReporting([1]);
  expect(useMailStore.getState().undo).toBeNull();
  expect(useMailStore.getState().error).toBeNull();
  native.start.mockImplementation(async ({ scope }) => ({
    ...outcome(scope, true),
    result: { deleted: 1, failed: 1, queuedBackup: 2, needsResync: 3 },
  }));
  const result = await purgeEverywhereReporting([2]);
  expect(result).toEqual({
    deleted: 1,
    failed: 1,
    queuedBackup: 2,
    needsResync: 3,
  });
  expect(useMailStore.getState().errorType).toBe('warning');
  expect(useMailStore.getState().errorTypeFor).toBe(
    useMailStore.getState().error
  );
});
it('retains Sent and unified same-UID original identities separately', async () => {
  const inbox = {
    ...row(1),
    _accountId: ACCOUNT.id,
    _mailbox: 'INBOX',
    _nativeIdentity: { ...row(1)._nativeIdentity, mailbox: 'INBOX' },
  };
  const sent = {
    ...row(1),
    _accountId: ACCOUNT.id,
    _mailbox: 'Sent',
    _fromSentFolder: true,
    _nativeIdentity: { ...row(1)._nativeIdentity, mailbox: 'Sent' },
  };
  useMailStore.setState({
    activeMailbox: 'UNIFIED',
    emails: [inbox],
    sentEmails: [sent],
  });
  await purgeEverywhere([`${ACCOUNT.id}:INBOX:1`, `${ACCOUNT.id}:Sent:1`], {
    rows: [inbox, sent],
  });
  expect(
    native.start.mock.calls[0][0].scope.targetHints.map((h) => h.mailbox)
  ).toEqual(['INBOX', 'Sent']);
  expect(native.start).toHaveBeenCalledTimes(1);
});
it('keeps an unproved selected target unresolved instead of sampling a visible replacement', async () => {
  useMailStore.setState({
    selectedEmailIds: new Set([1]),
    selectedEmailSnapshots: new Map([[1, null]]),
  });
  await purgeEverywhere([1]);
  expect(native.start.mock.calls[0][0].scope.targetHints).toEqual([]);
  expect(useMailStore.getState().emails.some((e) => e.uid === 1)).toBe(true);
});

it('waits for Undo rekey and refuses to transplant original proof to the new UID', async () => {
  prime({ emails: [] });
  await setDeleteUndo([
    {
      account: ACCOUNT,
      accountId: ACCOUNT.id,
      mailbox: 'INBOX.Spam',
      uid: 1,
      trash: 'Trash',
      trashUid: 71,
      messageId: 'm1@mock',
      row: row(1),
      view: `${ACCOUNT.id}|INBOX.Spam||INBOX`,
    },
  ]);
  let release;
  mockMoveEmails.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const undo = useMailStore.getState().runUndo();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const purge = purgeEverywhere([1], {
    scope: captureBulkScope([1], useMailStore.getState(), [row(1)]),
  });
  expect(native.start).not.toHaveBeenCalled();
  release({ newUids: [171] });
  await undo;
  await purge;
  expect(native.start.mock.calls[0][0].scope.keys).toEqual([171]);
  expect(native.start.mock.calls[0][0].scope.targetHints).toEqual([]);
});
it('does not let a successful A tombstone hide a later B under the same tuple', async () => {
  native.start.mockImplementation(async ({ scope }) => {
    useMailStore.setState({
      emails: [
        {
          ...row(1),
          messageId: 'B',
          _nativeIdentity: { ...row(1)._nativeIdentity, originHash: 'B' },
        },
      ],
    });
    return outcome(scope);
  });
  await purgeEverywhere([1]);
  expect(useMailStore.getState().emails[0].messageId).toBe('B');
  expect(useMailStore.getState().deleteTombstones.size).toBe(0);
});

it('restores a refused exact search row without reviving another search run', async () => {
  const hit = { ...row(1), _accountId: ACCOUNT.id, _mailbox: 'INBOX.Spam' };
  mockSearch.searchResults = [hit];
  mockSearch.searchRowsOutsideIndex = [hit];
  mockRemoveSearchResults.mockImplementation(() => {
    mockSearch.searchResults = [];
    mockSearch.searchRowsOutsideIndex = [];
    mockSearch.excludedSearchCopies = new Set([`${ACCOUNT.id}|INBOX.Spam|1`]);
  });
  native.start.mockImplementation(async ({ scope }) => outcome(scope, true));
  await purgeEverywhere([1]);
  expect(mockSearch.searchResults.map((row) => row.uid)).toEqual([1]);
  expect(mockSearch.excludedSearchCopies.size).toBe(0);
});

it('never borrows an unrelated non-null B companion after Undo maps A onto its UID', async () => {
  prime({ emails: [] });
  await setDeleteUndo([
    {
      account: ACCOUNT,
      accountId: ACCOUNT.id,
      mailbox: 'INBOX.Spam',
      uid: 1,
      trash: 'Trash',
      trashUid: 71,
      messageId: 'm1@mock',
      row: row(1),
      view: `${ACCOUNT.id}|INBOX.Spam||INBOX`,
    },
  ]);
  let release;
  mockMoveEmails.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const undo = useMailStore.getState().runUndo();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const original = captureBulkScope([1], useMailStore.getState(), [row(1)]);
  const purge = purgeEverywhere([1], { scope: original });
  const replacement = {
    ...row(171),
    messageId: 'B',
    _nativeIdentity: {
      ...row(171)._nativeIdentity,
      uidValidity: 2,
      originHash: 'B',
    },
  };
  useMailStore.setState({
    emails: [replacement],
    selectedEmailIds: new Set([171]),
    selectedEmailSnapshots: new Map([
      [171, captureSelectionSnapshot(replacement, ACCOUNT.id, 'INBOX.Spam')],
    ]),
  });
  release({ newUids: [171] });
  await undo;
  await purge;
  expect(native.start.mock.calls[0][0].scope.keys).toEqual([171]);
  expect(native.start.mock.calls[0][0].scope.targetHints).toEqual([]);
  expect(
    useMailStore.getState().emails.some((row) => row.messageId === 'B')
  ).toBe(true);
});
