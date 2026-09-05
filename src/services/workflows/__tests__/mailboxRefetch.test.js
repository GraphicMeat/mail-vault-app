// Refresh must reach the server for the folder list too, not just the probe.
import { describe, it, expect } from 'vitest';
import { forceMailboxRefetch, takeForcedMailboxRefetch } from '../helpers/mailboxRefetch';

describe('forced mailbox refetch', () => {
  it('is consumed exactly once, per account', () => {
    expect(takeForcedMailboxRefetch('a')).toBe(false);
    forceMailboxRefetch('a');
    expect(takeForcedMailboxRefetch('b')).toBe(false);
    expect(takeForcedMailboxRefetch('a')).toBe(true);
    expect(takeForcedMailboxRefetch('a')).toBe(false);
  });
});
