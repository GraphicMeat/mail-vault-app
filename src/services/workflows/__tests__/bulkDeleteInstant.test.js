// A bulk delete takes its rows off the screen at the click, a saved view's
// rows (searchResults) included, before anything waits on the daemon; and it
// reports in the list's corner panel, the one every bulk run uses.
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
  bulkDeleteFromServer,
  mockQueueOp,
  mockRemoveSearchResults,
} from './purgeEverywhereHarness';
import { captureBulkScope } from '../../bulkSelection.js';
import '../bindStoreActions';

const row = (uid) => ({
  ...serverMsg(uid),
  _nativeIdentity: { accountId: ACCOUNT.id, mailbox: 'INBOX.Spam', uidValidity: 1, originHash: 'A' },
});
const landed = (scope) => ({
  status: 'complete',
  result: { deleted: scope.keys.length, failed: 0, queuedBackup: 0, needsResync: 0 },
  outcomes: scope.targetHints.map((hint) => ({
    hint,
    target: {
      accountId: hint.accountId, mailbox: hint.mailbox, uid: hint.uid, proof: { kind: 'server' },
      refused: false, skipped: false, server: 'complete', local: 'complete', mirror: 'pending', lastError: null,
    },
  })),
});
// A turn of the event loop: a first dynamic import resolves in one. The
// journal stays unanswered throughout, so nothing here waits on it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The journal write is a daemon round trip; a busy daemon (a sync, an index
// pass) answers it late. Nothing on screen may wait for it.
let releaseJournal;
beforeEach(() => {
  native.start.mockReset().mockImplementation(async ({ scope }) => landed(scope));
  prime({ emails: [row(1), row(2), row(3)] });
  useMailStore.setState({ selectedEmailSnapshots: new Map(), selectedEmailIds: new Set(), error: null, undo: null, mailboxScope: null, localFolders: {} });
  const waiting = [];
  releaseJournal = () => waiting.splice(0).forEach((resolve, i) => resolve(i + 1));
  mockQueueOp.mockImplementation(() => new Promise((resolve) => waiting.push(resolve)));
});

it('delete everywhere takes the rows and the view hits off the screen before the journal answers', async () => {
  const run = purgeEverywhere([1, 2]);
  await flush();
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([3]);
  expect(mockRemoveSearchResults).toHaveBeenCalled();
  expect(native.start).not.toHaveBeenCalled();
  releaseJournal();
  await run;
  expect(native.start).toHaveBeenCalled();
});

it('delete from server takes the rows and the view hits off the screen before the journal answers', async () => {
  const scope = captureBulkScope([1, 2], useMailStore.getState());
  const run = bulkDeleteFromServer(scope);
  await flush();
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([3]);
  expect(mockRemoveSearchResults).toHaveBeenCalled();
  releaseJournal();
  await run;
});

it('a delete of several messages reports in the corner panel, one message does not', async () => {
  mockQueueOp.mockResolvedValue(1);
  await purgeEverywhere([1, 2]);
  expect(native.start.mock.calls[0][0].panel).toBe(true);
  native.start.mockClear();
  await purgeEverywhere([3]);
  expect(native.start.mock.calls[0][0].panel).toBeFalsy();
});

it('a bulk delete from server reports in the corner panel', async () => {
  mockQueueOp.mockResolvedValue(1);
  await bulkDeleteFromServer(captureBulkScope([1, 2], useMailStore.getState()));
  expect(native.start.mock.calls[0][0].panel).toBe(true);
});
