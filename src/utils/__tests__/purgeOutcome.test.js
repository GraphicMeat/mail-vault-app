import { it, expect } from 'vitest';
import { splitChangedOutcome } from '../purgeOutcome.js';

const CHANGED = 'errors.bulkIdentityChanged';
const UNCERTAIN = 'errors.bulkIdentityUncertain';
const target = (mailbox, uid, extra) => ({ accountId: 'a', mailbox, uid, refused: false, skipped: false, needsResync: false, lastError: null, ...extra });

it('passes a result with nothing refused through untouched', () => {
  const result = { deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 };
  expect(splitChangedOutcome(result, [target('M', 1, { proof: { kind: 'server' }, server: 'complete', local: 'complete' })])).toBe(result);
});

// The daemon counts a target held back for a resync as failed AND its mailbox
// as needing one: one message read "1 could not be deleted ... 1 was skipped
// because this mailbox needs to resync". It is one message, said once.
it('says a target waiting for a resync once, not also as failed', () => {
  const result = { deleted: 347, failed: 1, queuedBackup: 0, needsResync: 1 };
  expect(splitChangedOutcome(result, [target('M', 1, { refused: true, needsResync: true, lastError: UNCERTAIN })]))
    .toEqual({ deleted: 347, failed: 0, queuedBackup: 0, needsResync: 1 });
});

it('counts every message waiting for a resync, not its mailbox', () => {
  const finals = [1, 2, 3].map(uid => target('M', uid, { refused: true, needsResync: true, lastError: UNCERTAIN }));
  expect(splitChangedOutcome({ deleted: 0, failed: 3, queuedBackup: 0, needsResync: 1 }, finals))
    .toEqual({ deleted: 0, failed: 0, queuedBackup: 0, needsResync: 3 });
});

// M: X was held back, proved and retried (retryAfterResync already took M off
// needsResync), Y was relabelled changed. N: Z is still waiting for a resync.
// Only N still needs one, and its clause must survive.
it('counts what still needs a resync from the final outcomes', () => {
  const finals = [
    target('M', 1, { proof: { kind: 'server' }, server: 'complete', local: 'complete' }),
    target('M', 2, { refused: true, needsResync: true, lastError: CHANGED }),
    target('N', 3, { refused: true, needsResync: true, lastError: UNCERTAIN }),
  ];
  const adjusted = { deleted: 1, failed: 2, queuedBackup: 0, needsResync: 1 };
  expect(splitChangedOutcome(adjusted, finals)).toEqual({ deleted: 1, failed: 0, changed: 1, queuedBackup: 0, needsResync: 1 });
});

it('drops a mailbox whose only reason to resync was a changed target', () => {
  const finals = [target('M', 2, { refused: true, needsResync: true, lastError: CHANGED })];
  expect(splitChangedOutcome({ deleted: 0, failed: 1, queuedBackup: 0, needsResync: 1 }, finals))
    .toEqual({ deleted: 0, failed: 0, changed: 1, queuedBackup: 0, needsResync: 0 });
});

// One mailbox holds a changed target AND an uncertain one nothing has proved:
// the changed one leaves, the uncertain one still waits for its resync.
it('keeps a mailbox that holds a changed target and an unproved uncertain one in needsResync', () => {
  const finals = [
    target('M', 2, { refused: true, needsResync: true, lastError: CHANGED }),
    target('M', 3, { refused: true, needsResync: true, lastError: UNCERTAIN }),
  ];
  expect(splitChangedOutcome({ deleted: 0, failed: 2, queuedBackup: 0, needsResync: 1 }, finals))
    .toEqual({ deleted: 0, failed: 0, changed: 1, queuedBackup: 0, needsResync: 1 });
});
