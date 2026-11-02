import { it, expect } from 'vitest';
import { splitChangedOutcome } from '../purgeOutcome.js';

const CHANGED = 'errors.bulkIdentityChanged';
const UNCERTAIN = 'errors.bulkIdentityUncertain';
const target = (mailbox, uid, extra) => ({ accountId: 'a', mailbox, uid, refused: false, skipped: false, needsResync: false, lastError: null, ...extra });

it('passes a result with no changed target through untouched', () => {
  const result = { deleted: 1, failed: 1, queuedBackup: 0, needsResync: 1 };
  expect(splitChangedOutcome(result, [target('M', 1, { refused: true, needsResync: true, lastError: UNCERTAIN })])).toBe(result);
});

// M: X was held back, proved and retried (retryAfterResync already took M off
// needsResync), Y was relabelled changed. N: Z is still waiting for a resync.
// Only N still needs one, and its clause must survive.
it('counts the mailboxes that still need a resync from the final outcomes', () => {
  const finals = [
    target('M', 1, { proof: { kind: 'server' }, server: 'complete', local: 'complete' }),
    target('M', 2, { refused: true, needsResync: true, lastError: CHANGED }),
    target('N', 3, { refused: true, needsResync: true, lastError: UNCERTAIN }),
  ];
  const adjusted = { deleted: 1, failed: 2, queuedBackup: 0, needsResync: 1 };
  expect(splitChangedOutcome(adjusted, finals)).toEqual({ deleted: 1, failed: 1, changed: 1, queuedBackup: 0, needsResync: 1 });
});

it('drops a mailbox whose only reason to resync was a changed target', () => {
  const finals = [target('M', 2, { refused: true, needsResync: true, lastError: CHANGED })];
  expect(splitChangedOutcome({ deleted: 0, failed: 1, queuedBackup: 0, needsResync: 1 }, finals))
    .toEqual({ deleted: 0, failed: 0, changed: 1, queuedBackup: 0, needsResync: 0 });
});

// One mailbox holds a changed target AND an uncertain one nothing has proved:
// the changed one leaves, the mailbox still needs its resync, counted once.
it('keeps a mailbox that holds a changed target and an unproved uncertain one in needsResync', () => {
  const finals = [
    target('M', 2, { refused: true, needsResync: true, lastError: CHANGED }),
    target('M', 3, { refused: true, needsResync: true, lastError: UNCERTAIN }),
  ];
  expect(splitChangedOutcome({ deleted: 0, failed: 2, queuedBackup: 0, needsResync: 1 }, finals))
    .toEqual({ deleted: 0, failed: 1, changed: 1, queuedBackup: 0, needsResync: 1 });
});
