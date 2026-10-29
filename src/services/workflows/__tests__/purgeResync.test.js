// A delete the native worker refuses for want of identity (a row cached before
// the identity existed, a search hit) is proved from the header cache, or after
// a resync of its mailbox, and runs again.
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
  mockSyncNow,
  mockWaitForSync,
  mockGetEmailHeadersByUids,
  mockGetEmailHeadersMeta,
} from './purgeEverywhereHarness';
import { retryAfterResync } from '../purgeResync.js';

const MAILBOX = 'INBOX.Spam';
const identity = { accountId: ACCOUNT.id, mailbox: MAILBOX, uidValidity: 1, originHash: 'A' };
// What an old cache hands the list: no native identity on the row.
const bare = (uid) => serverMsg(uid);
const refused = (hint, lastError = 'errors.bulkIdentityUncertain') => ({
  accountId: hint.accountId, mailbox: hint.mailbox, uid: hint.uid,
  proof: null, refused: true, skipped: false, needsResync: true, lastError,
  server: 'pending', local: 'pending', mirror: 'pending',
});
const done = (hint) => ({
  ...refused(hint), refused: false, needsResync: false, lastError: undefined,
  proof: { kind: 'server' }, server: 'complete', local: 'complete',
});
const counts = (deleted, failed, needsResync) => ({ deleted, failed, queuedBackup: 0, needsResync });
// The worker refuses a hint with no identity, and runs one that carries it.
function worker(lastError) {
  native.start.mockImplementation(async ({ scope }) => {
    const ok = scope.targetHints.every((hint) => hint.nativeIdentity);
    return {
      status: 'complete',
      result: ok ? counts(scope.keys.length, 0, 0) : counts(0, scope.keys.length, 1),
      outcomes: scope.targetHints.map((hint) => ({
        hint, target: ok ? done(hint) : refused(hint, lastError),
      })),
    };
  });
}
beforeEach(() => {
  native.start.mockReset();
  worker();
  prime({ emails: [bare(1), bare(2)] });
  useMailStore.setState({
    selectedEmailSnapshots: new Map(), selectedEmailIds: new Set(), error: null,
    undo: null, mailboxScope: null, localFolders: {},
  });
  mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, nativeIdentity: identity });
  mockGetEmailHeadersByUids.mockImplementation(async (_a, _m, uids) => uids.map(bare));
});

it('re-proves the refused row from the header cache by Message-ID and deletes it', async () => {
  const result = await purgeEverywhere([1]);
  expect(mockSyncNow).not.toHaveBeenCalled();
  expect(native.start).toHaveBeenCalledTimes(2);
  expect(native.start.mock.calls[1][0].scope.targetHints[0]).toMatchObject({
    uid: 1, messageId: 'm1@mock', nativeIdentity: { originHash: 'A' },
  });
  expect(result).toEqual(counts(1, 0, 0));
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
});

it('resyncs the mailbox when the cache cannot prove the row, then deletes it', async () => {
  mockGetEmailHeadersMeta.mockResolvedValueOnce({ uidValidity: 1, nativeIdentity: null });
  const result = await purgeEverywhere([1]);
  expect(mockSyncNow).toHaveBeenCalledTimes(1);
  expect(mockSyncNow.mock.calls[0][1]).toBe(MAILBOX);
  expect(mockWaitForSync).toHaveBeenCalledWith(7, expect.any(Number));
  expect(native.start).toHaveBeenCalledTimes(2);
  expect(native.start.mock.calls[1][0].scope.targetHints[0]).toMatchObject({
    uid: 1, messageId: 'm1@mock', nativeIdentity: { originHash: 'A' },
  });
  expect(result).toEqual(counts(1, 0, 0));
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
});

// A search hit past the cached window: the cache holds no row for its uid, so
// the folder's identity stands in. The worker checks UIDVALIDITY and the
// Message-ID at that uid on the server before it deletes anything.
it('proves a search hit the cache never held by its folder identity', async () => {
  mockGetEmailHeadersByUids.mockResolvedValue([]);
  const result = await purgeEverywhere([1]);
  expect(mockSyncNow).not.toHaveBeenCalled();
  expect(native.start).toHaveBeenCalledTimes(2);
  expect(native.start.mock.calls[1][0].scope.targetHints[0]).toMatchObject({
    uid: 1, messageId: 'm1@mock', nativeIdentity: identity,
  });
  expect(result).toEqual(counts(1, 0, 0));
  expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([2]);
});

it('never retries a row whose Message-ID changed under the uid', async () => {
  mockGetEmailHeadersByUids.mockResolvedValue([{ ...bare(1), messageId: 'stranger@mock' }]);
  const result = await purgeEverywhere([1]);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(result).toEqual(counts(0, 1, 1));
  expect(useMailStore.getState().emails.map((e) => e.uid).sort()).toEqual([1, 2]);
});

// The verdict callers key on: a uid the cache shows holding another message is
// refused as changed, not left looking like a wait for identity.
it('files a uid the cache shows holding another message as changed', async () => {
  mockGetEmailHeadersByUids.mockResolvedValue([{ ...bare(1), messageId: 'stranger@mock' }]);
  const hint = { accountId: ACCOUNT.id, mailbox: MAILBOX, uid: 1, nativeIdentity: null,
    messageIdPresent: true, messageId: 'm1@mock', graphId: null, jmapId: null };
  const operation = { result: counts(0, 1, 1), outcomes: [{ hint, target: refused(hint) }] };
  const judged = await retryAfterResync(operation, { accountId: ACCOUNT.id, mailbox: MAILBOX, keys: [1], targetHints: [hint] });
  expect(judged.outcomes[0].target.lastError).toBe('errors.bulkIdentityChanged');
  expect(mockSyncNow).not.toHaveBeenCalled();
  expect(native.start).not.toHaveBeenCalled();
});

it('keeps the refusal when nothing proves the row and the resync fails', async () => {
  mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, nativeIdentity: null });
  mockWaitForSync.mockResolvedValue({ success: false });
  await purgeEverywhere([1]);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(useMailStore.getState().emails.map((e) => e.uid).sort()).toEqual([1, 2]);
});

it('does not resync a row that has no Message-ID to prove it by', async () => {
  prime({ emails: [{ ...bare(1), messageId: undefined }, bare(2)] });
  await purgeEverywhere([1]);
  expect(mockSyncNow).not.toHaveBeenCalled();
  expect(native.start).toHaveBeenCalledTimes(1);
});

it('does not resync when the worker saw the identity change', async () => {
  worker('errors.bulkIdentityChanged');
  await purgeEverywhere([1]);
  expect(mockSyncNow).not.toHaveBeenCalled();
  expect(native.start).toHaveBeenCalledTimes(1);
});

it('does not retry when the resynced cache still carries no identity', async () => {
  mockGetEmailHeadersByUids.mockImplementation(async (_a, _m, uids) => uids.map(bare));
  mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, nativeIdentity: null });
  await purgeEverywhere([1]);
  expect(mockSyncNow).toHaveBeenCalledTimes(1);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(useMailStore.getState().emails.map((e) => e.uid).sort()).toEqual([1, 2]);
});
