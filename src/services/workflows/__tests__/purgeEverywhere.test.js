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
  bulkDeleteFromServer,
  replayPurge,
  hideQueuedDeletes,
  showQueuedRows,
  mockQueueOp,
  mockClearOps,
  mockNoteOpFailure,
  mockReadOps,
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
// The daemon's final word: the message it found is not the one selected.
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
  lastError: 'errors.bulkIdentityChanged',
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
  // A refusal is the daemon's verdict, not a hiccup: no retry, and nothing
  // stays owed: the journal entry written before the run is cleared.
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(mockClearOps).toHaveBeenCalledWith(expect.objectContaining({ op: 'purge', uids: [1] }));
  expect(
    useMailStore
      .getState()
      .emails.map((e) => e.uid)
      .sort()
  ).toEqual([1, 2]);
  expect(useMailStore.getState().deleteTombstones.size).toBe(0);
});
// A row that outlived the first delete (a ghost the list or the cache put
// back) is deleted again: the daemon finds the message already gone and answers
// a skipped, `alreadyGone` target. That is proof the message is gone, so the row
// stays out of the list instead of being put back as a refused delete.
it('keeps the row gone when the daemon found the message already deleted', async () => {
  native.start.mockImplementation(async ({ scope }) => ({
    status: 'complete',
    result: { deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 },
    outcomes: scope.targetHints.map((hint) => ({
      hint,
      target: { ...refused(hint), refused: false, skipped: true, alreadyGone: true },
    })),
  }));
  const result = await purgeEverywhere([1]);
  expect(result).toEqual({ deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 });
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
  expect(useMailStore.getState().deleteTombstones.size).toBe(1);
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

it('hides the matching bound original despite its sparse unbound archived duplicate', async () => {
  prime({
    emails: [row(1), row(2)],
    localOnly: [{ uid: 1, flags: ['archived'], source: 'local' }],
  });
  native.start.mockImplementation(async ({ scope }) => {
    expect(useMailStore.getState().emails.some((row) => row.uid === 1)).toBe(
      false
    );
    expect(
      useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|1`)
    ).toBe(true);
    return outcome(scope);
  });
  await purgeEverywhere([1]);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(
    native.start.mock.calls[0][0].scope.targetHints[0].nativeIdentity.originHash
  ).toBe('A');
});

it('keeps known conflicting message identity visible without borrowing it into the request', async () => {
  const original = captureBulkScope([1], useMailStore.getState(), [row(1)]);
  const replacement = { ...row(1), messageId: 'B', _nativeIdentity: undefined };
  useMailStore.setState({ emails: [replacement] });
  native.start.mockImplementation(async ({ scope }) => outcome(scope, true));
  await purgeEverywhere([1], { scope: original });
  expect(useMailStore.getState().emails[0].messageId).toBe('B');
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(native.start.mock.calls[0][0].scope.targetHints[0].messageId).toBe(
    'm1@mock'
  );
});

it.each(['original', 'replacement'])(
  'reconciles an offscreen UNIFIED selection when its %s arrives during native work',
  async (arrival) => {
    const key = `${ACCOUNT.id}:INBOX:7`;
    const original = {
      ...row(7),
      _accountId: ACCOUNT.id,
      _mailbox: 'INBOX',
      _nativeIdentity: { ...row(7)._nativeIdentity, mailbox: 'INBOX' },
    };
    const hint = captureSelectionSnapshot(original, ACCOUNT.id, 'INBOX');
    useMailStore.setState({
      activeMailbox: 'UNIFIED',
      emails: [],
      sentEmails: [],
      localEmails: [],
      selectedEmail: null,
      selectedEmailId: null,
      selectedThread: null,
      emailCache: new Map(),
      selectedEmailIds: new Set([key]),
      selectedEmailSnapshots: new Map([[key, hint]]),
    });
    let finish;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    native.start.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const run = purgeEverywhere([key]);
    await started;
    const arrived =
      arrival === 'original'
        ? original
        : {
            ...original,
            messageId: 'B',
            _nativeIdentity: { ...original._nativeIdentity, originHash: 'B' },
          };
    useMailStore.setState({ emails: [arrived], totalEmails: 1 });
    useMailStore.getState().updateSortedEmails();
    finish(outcome(native.start.mock.calls[0][0].scope));
    await run;
    const shown = useMailStore
      .getState()
      .sortedEmails.filter((row) => row.uid === 7);
    if (arrival === 'original') {
      expect(shown).toEqual([]);
      expect(
        useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX|7`)
      ).toBe(true);
    } else {
      expect(shown.map((row) => row.messageId)).toEqual(['B']);
      expect(
        useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX|7`)
      ).toBe(false);
    }
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.start.mock.calls[0][0].scope.targetHints).toEqual([hint]);
    expect(useMailStore.getState().loadEmails).not.toHaveBeenCalled();
  }
);

it('keeps a positive-ID B visible when the retained bound original explicitly has no Message-ID', async () => {
  const original = { ...row(1), messageId: null };
  const replacement = { ...row(1), messageId: 'B', _nativeIdentity: undefined };
  useMailStore.setState({
    emails: [replacement],
    sentEmails: [],
    localEmails: [],
    selectedEmail: original,
    selectedEmailId: 1,
    selectedThread: null,
  });
  const scope = captureBulkScope([1], useMailStore.getState(), [original]);
  native.start.mockImplementation(async ({ scope }) => outcome(scope, true));
  await purgeEverywhere([1], { scope });
  expect(useMailStore.getState().emails.map((row) => row.messageId)).toEqual([
    'B',
  ]);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(native.start.mock.calls[0][0].scope.targetHints[0]).toMatchObject({
    messageIdPresent: true,
    messageId: null,
    nativeIdentity: { originHash: 'A' },
  });
});

// The native manager runs one operation at a time and throws "already running"
// for a second. A delete clicked while another is still on the wire used to hit
// that throw, restore its row and reject: slow first delete, second one back.
it('a delete clicked while another runs waits its turn and stays gone', async () => {
  const release = [];
  let running = 0;
  native.start.mockImplementation(async ({ scope }) => {
    if (running) throw new Error('An operation is already running');
    running++;
    await new Promise((resolve) => release.push(resolve));
    running--;
    return outcome(scope);
  });
  const first = purgeEverywhere([1]);
  await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
  const second = purgeEverywhere([2]).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  // The row leaves the list at once, but the daemon is not asked yet.
  await vi.waitFor(() =>
    expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([])
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(native.start).toHaveBeenCalledTimes(1);
  release[0]();
  await first;
  await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(2));
  release[1]();
  const settled = await second;
  expect(settled.error).toBeUndefined();
  expect(settled.value.deleted).toBe(1);
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([]);
  expect(useMailStore.getState().deleteTombstones.size).toBe(2);
});

// A target the daemon tried and could not finish (no proof: the server step
// failed) goes again, five times at most with a doubling wait (DELETE_RETRY,
// no wait under test). Its row stays gone the whole time; only the retried
// target is sent again.
const unfinished = (hint) => ({ ...refused(hint), refused: false });
function partly(scope, fails) {
  const failed = scope.targetHints.filter((hint) => fails(hint)).length;
  return {
    status: 'complete',
    result: { deleted: scope.targetHints.length - failed, failed, queuedBackup: 0, needsResync: 0 },
    outcomes: scope.targetHints.map((hint) => ({
      hint,
      target: fails(hint)
        ? unfinished(hint)
        : { ...refused(hint), refused: false, proof: { kind: 'server' }, server: 'complete', local: 'complete' },
    })),
  };
}

it('retries only the unfinished target, keeps its row hidden, and settles once it lands', async () => {
  let tries = 0;
  native.start.mockImplementation(async ({ scope }) => {
    expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([]);
    tries++;
    return partly(scope, (hint) => hint.uid === 2 && tries < 3);
  });
  const result = await purgeEverywhere([1, 2]);
  expect(native.start).toHaveBeenCalledTimes(3);
  expect(native.start.mock.calls[1][0].scope.targetHints.map((h) => h.uid)).toEqual([2]);
  expect(native.start.mock.calls[1][0].scope.keys).toEqual([2]);
  expect(result).toEqual({ deleted: 2, failed: 0, queuedBackup: 0, needsResync: 0 });
  expect(useMailStore.getState().emails).toEqual([]);
  expect(useMailStore.getState().deleteTombstones.size).toBe(2);
});

// Past the quick retries the purge stays owed: its row stays gone, its journal
// entry stays queued with the reason, and nothing is said now.
it('keeps a purge that never lands queued and hidden, and says nothing', async () => {
  native.start.mockImplementation(async ({ scope }) => partly(scope, () => true));
  const result = await purgeEverywhereReporting([1]);
  expect(native.start).toHaveBeenCalledTimes(6);
  expect(result).toMatchObject({ failed: 0, queued: 1 });
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
  expect(useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|1`)).toBe(true);
  expect(mockClearOps).not.toHaveBeenCalled();
  expect(mockNoteOpFailure).toHaveBeenCalledWith(
    { op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uid: 1 }, expect.any(String));
  expect(useMailStore.getState().error).toBeNull();
});

it('journals the purge with its proof before asking the daemon, and clears it once it lands', async () => {
  native.start.mockImplementation(async ({ scope }) => {
    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1],
      arg: { hints: [expect.objectContaining({ uid: 1, messageId: 'm1@mock', nativeIdentity: expect.objectContaining({ originHash: 'A' }) })] },
    });
    return outcome(scope);
  });
  await purgeEverywhere([1]);
  expect(mockClearOps).toHaveBeenCalledWith(expect.objectContaining({ op: 'purge', uids: [1] }));
});

it('keeps every purge of a run that kept failing outright queued, without throwing', async () => {
  native.start.mockRejectedValue(new Error('daemon unavailable'));
  const result = await purgeEverywhere([1]);
  expect(native.start).toHaveBeenCalledTimes(6);
  expect(result.queued).toBe(1);
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
  expect(mockNoteOpFailure).toHaveBeenCalledWith(expect.objectContaining({ op: 'purge', uid: 1 }), 'daemon unavailable');
});

it('retries a run that failed outright and keeps the row gone when a later try lands', async () => {
  native.start
    .mockRejectedValueOnce(new Error('daemon unavailable'))
    .mockImplementation(async ({ scope }) => outcome(scope));
  const result = await purgeEverywhere([1]);
  expect(native.start).toHaveBeenCalledTimes(2);
  expect(result.deleted).toBe(1);
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
});

// The bulk tool's delete from the server: one native batch, rows gone at the
// click, tombstones lifted and the view reloaded once the run ends, so what
// the server kept comes back from the cache the daemon already pruned.
it('bulk-tool delete journals the range, hides its rows for the run, then clears, lifts and reloads', async () => {
  const scope = captureBulkScope([1], useMailStore.getState());
  native.start.mockImplementation(async ({ type }) => {
    expect(type).toBe('delete');
    expect(mockQueueOp).toHaveBeenCalledWith({ op: 'delete', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1], arg: {} });
    expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
    expect(useMailStore.getState().deleteTombstones.size).toBe(1);
    return { status: 'complete', errors: 0 };
  });
  await bulkDeleteFromServer(scope);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(mockClearOps).toHaveBeenCalledWith({ op: 'delete', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1], arg: {} });
  expect(useMailStore.getState().deleteTombstones.size).toBe(0);
  expect(useMailStore.getState().loadEmails).toHaveBeenCalled();
});

// A run with no record of what it removed cannot say which uid landed, so the
// whole range stays owed and hidden; replayOps re-sends it.
it('bulk-tool delete with errors and no per-message record keeps the range queued and its rows hidden', async () => {
  const scope = captureBulkScope([1], useMailStore.getState());
  native.start.mockResolvedValue({ status: 'complete', errors: 1, lastError: 'NO server busy' });
  await bulkDeleteFromServer(scope);
  expect(mockClearOps).not.toHaveBeenCalled();
  expect(mockNoteOpFailure).toHaveBeenCalledWith(expect.objectContaining({ op: 'delete', uid: 1 }), 'NO server busy');
  expect(useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|1`)).toBe(true);
});

// A purge of several messages names them all in its entry. One the daemon
// refused comes off the queue (its row is put back) with its reason kept, so
// Settings does not list it as deleted beside the one still owed.
it('keeps the whole list on a partly owed purge and marks a refused message as not deleted', async () => {
  native.start.mockImplementation(async ({ scope }) => ({
    status: 'complete',
    result: { deleted: 0, failed: scope.targetHints.length, queuedBackup: 0, needsResync: 0 },
    outcomes: scope.targetHints.map((hint) => ({ hint, target: hint.uid === 1 ? refused(hint) : unfinished(hint) })),
  }));
  await purgeEverywhere([1, 2]);
  const queued = mockQueueOp.mock.calls[0][0];
  expect(queued.arg.total).toBe(2);
  expect(queued.arg.messages.map((m) => m.uid)).toEqual([1, 2]);
  expect(mockClearOps).toHaveBeenCalledWith({ ...queued, uids: [1] });
  const notes = mockNoteOpFailure.mock.calls.map(([at]) => at.uid);
  expect(notes).toEqual(expect.arrayContaining([1, 2]));
  expect(mockClearOps.mock.invocationCallOrder[0])
    .toBeLessThan(mockNoteOpFailure.mock.invocationCallOrder[notes.lastIndexOf(1)]);
});

// Refused for want of proof is not the daemon's last word: a resync or a later
// replay may prove the message, so it is queued, its row stays gone and
// nothing is said. Its resync is the queue's to wait for, not the toast's.
it('queues a refusal for uncertain identity instead of restoring the row', async () => {
  native.start.mockImplementation(async ({ scope }) => ({
    status: 'complete',
    result: { deleted: 0, failed: 1, queuedBackup: 0, needsResync: 1 },
    outcomes: scope.targetHints.map((hint) => ({ hint,
      target: { ...refused(hint), needsResync: true, lastError: 'errors.bulkIdentityUncertain' } })),
  }));
  const result = await purgeEverywhereReporting([1]);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ failed: 0, needsResync: 0, queued: 1 });
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
  expect(useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|1`)).toBe(true);
  expect(mockClearOps).not.toHaveBeenCalled();
  expect(mockNoteOpFailure).toHaveBeenCalledWith(
    { op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uid: 1 }, 'errors.bulkIdentityUncertain');
  expect(useMailStore.getState().error).toBeNull();
});

it('still restores an uncertain refusal that has nothing to prove the message by', async () => {
  // An old cache row: no native identity, no Message-ID.
  prime({ emails: [{ ...serverMsg(1), messageId: undefined }, row(2)] });
  native.start.mockImplementation(async ({ scope: s }) => ({
    status: 'complete',
    result: { deleted: 0, failed: 1, queuedBackup: 0, needsResync: 0 },
    outcomes: s.targetHints.map((hint) => ({ hint, target: { ...refused(hint), lastError: 'errors.bulkIdentityUncertain' } })),
  }));
  await purgeEverywhere([1]);
  expect(mockClearOps).toHaveBeenCalled();
  expect(useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|1`)).toBe(false);
});

it('replay drops a purge the daemon now refuses for good and shows its row again', async () => {
  const hints = captureBulkScope([1, 2], useMailStore.getState()).targetHints;
  const entry = JSON.parse(JSON.stringify({ op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1, 2], arg: { hints } }));
  native.start.mockImplementation(async ({ scope }) => ({
    status: 'complete',
    outcomes: scope.targetHints.map((hint) => ({ hint, target: hint.uid === 1 ? refused(hint)
      : { ...refused(hint), lastError: 'errors.bulkIdentityUncertain' } })),
  }));
  const out = await replayPurge(entry);
  expect(out.landed).toEqual([]);
  expect(out.kept).toEqual([2]);
  expect(out.dropped).toEqual([{ uid: 1, error: 'errors.bulkIdentityChanged' }]);
});

// The entry keeps every message it was queued with (subject and sender), and
// only the ones the run removed come off `uids`: Settings shows which went.
it('bulk-tool delete with errors takes off only what the run removed and keeps the whole list', async () => {
  const scope = captureBulkScope([1, 2], useMailStore.getState());
  native.start.mockResolvedValue({ status: 'complete', errors: 1, lastError: 'NO server busy',
    deleted: [{ accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [2] }] });
  await bulkDeleteFromServer(scope);
  const queued = mockQueueOp.mock.calls[0][0];
  expect(queued.uids).toEqual([1, 2]);
  expect(queued.arg.total).toBe(2);
  expect(queued.arg.messages.map((m) => m.uid)).toEqual([1, 2]);
  expect(queued.arg.messages.every((m) => typeof m.subject === 'string' && typeof m.from === 'string')).toBe(true);
  expect(mockClearOps).toHaveBeenCalledTimes(1);
  expect(mockClearOps).toHaveBeenCalledWith({ ...queued, uids: [2] });
  expect(mockNoteOpFailure).toHaveBeenCalledTimes(1);
  expect(mockNoteOpFailure).toHaveBeenCalledWith(expect.objectContaining({ op: 'delete', uid: 1 }), 'NO server busy');
  expect(useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|1`)).toBe(true);
  expect(useMailStore.getState().deleteTombstones.has(`${ACCOUNT.id}|INBOX.Spam|2`)).toBe(false);
});

// ── the queue across sessions ──

it('hides every delete and purge the journal still owes, and shows them again when given up on', async () => {
  const ops = [
    { op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1], arg: { hints: [] } },
    { op: 'flag', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [2], arg: {} },
  ];
  mockReadOps.mockResolvedValue(ops);
  await hideQueuedDeletes();
  expect([...useMailStore.getState().deleteTombstones]).toEqual([`${ACCOUNT.id}|INBOX.Spam|1`]);
  expect(useMailStore.getState().sortedEmails.map((e) => e.uid)).toEqual([2]);
  await showQueuedRows(ops[0]);
  expect(useMailStore.getState().deleteTombstones.size).toBe(0);
  expect(useMailStore.getState().loadEmails).toHaveBeenCalled();
});

it('replays a queued purge with its stored proof and says which uids landed', async () => {
  const hint = captureBulkScope([1, 2], useMailStore.getState()).targetHints;
  const entry = JSON.parse(JSON.stringify({ op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1, 2, 3], arg: { hints: hint } }));
  native.start.mockImplementation(async ({ type, scope }) => {
    expect(type).toBe('delete_everywhere');
    expect(scope.targetHints.map((h) => h.uid)).toEqual([1, 2]);
    return partly(scope, (h) => h.uid === 2);
  });
  const result = await replayPurge(entry);
  // 3 has no stored proof: nothing can ever prove it again, so it is answered.
  expect(result.landed.sort()).toEqual([1, 3]);
  expect(result.kept).toEqual([2]);
});

it('keeps a replayed purge whole when the daemon run fails', async () => {
  const hint = captureBulkScope([1], useMailStore.getState()).targetHints;
  native.start.mockRejectedValue(new Error('An operation is already running'));
  const result = await replayPurge({ op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1], arg: { hints: hint } });
  expect(result).toEqual({ landed: [], kept: [1], error: 'An operation is already running' });
});

// A delete re-attached at launch holds the manager outside the purge queue;
// a replay meeting it must not count its purge as failed (no reminder for a
// delete that is in fact running).
it('leaves a replayed purge alone while another run holds the manager', async () => {
  const { bulkOperationManager } = await import('../../BulkOperationManager.js');
  const hint = captureBulkScope([1], useMailStore.getState()).targetHints;
  bulkOperationManager.isRunning = true;
  try {
    const result = await replayPurge({ op: 'purge', accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uids: [1], arg: { hints: hint } });
    expect(result).toEqual({ landed: [], kept: [], busy: [1], error: null });
    expect(native.start).not.toHaveBeenCalled();
  } finally {
    delete bulkOperationManager.isRunning;
  }
});
