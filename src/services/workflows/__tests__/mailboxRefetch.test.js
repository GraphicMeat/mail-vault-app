// Refresh must reach the server for the folder list too, not just the probe.
import { describe, it, expect, beforeEach } from 'vitest';
import { forceMailboxRefetch, takeForcedMailboxRefetch } from '../helpers/mailboxRefetch';

// Drains any flag a previous case left set on the module-level Set, so one
// case can never inherit another's force.
beforeEach(() => {
  takeForcedMailboxRefetch('a');
  takeForcedMailboxRefetch('b');
});

describe('forced mailbox refetch', () => {
  it('is consumed exactly once, per account', () => {
    expect(takeForcedMailboxRefetch('a')).toBe(false);
    forceMailboxRefetch('a');
    expect(takeForcedMailboxRefetch('b')).toBe(false);
    expect(takeForcedMailboxRefetch('a')).toBe(true);
    expect(takeForcedMailboxRefetch('a')).toBe(false);
  });
});
