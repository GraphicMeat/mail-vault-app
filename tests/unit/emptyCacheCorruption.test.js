import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — replicate the pure detection logic from mailStore for unit testing
// ---------------------------------------------------------------------------

function countMailboxes(mailboxes = []) {
  let count = 0;
  const visit = (nodes) => {
    for (const node of nodes || []) {
      count += 1;
      if (node.children?.length) visit(node.children);
    }
  };
  visit(mailboxes);
  return count;
}

function isMailboxTreeComplete(mailboxes = []) {
  const total = countMailboxes(mailboxes);
  if (total === 0) return false;
  if (total > 1) return true;
  const only = mailboxes[0];
  return !!only && only.path !== 'INBOX';
}

function isSuspiciousEmptyMailboxResult(freshMailboxes, cachedEntry) {
  if (!freshMailboxes || freshMailboxes.length > 0) return false;
  if (!cachedEntry) return false;
  const priorMailboxes = cachedEntry.lastKnownGoodMailboxes || cachedEntry.mailboxes;
  return isMailboxTreeComplete(priorMailboxes);
}

function isSuspiciousEmptyEmailResult(serverTotal, cachedHeaders, savedEmailIds) {
  if (serverTotal > 0) return false;
  const cachedTotal = cachedHeaders?.totalEmails || cachedHeaders?.lastKnownGoodTotalEmails || 0;
  const savedCount = savedEmailIds?.size || 0;
  return cachedTotal > 0 || savedCount > 0;
}

// Test data factories
const mkMailbox = (name, children = []) => ({
  name,
  path: name,
  specialUse: null,
  flags: [],
  delimiter: '/',
  noselect: false,
  children,
});

const mkCachedEntry = (mailboxes, opts = {}) => ({
  mailboxes,
  fetchedAt: Date.now(),
  lastKnownGoodMailboxes: opts.lastKnownGoodMailboxes || (mailboxes?.length > 0 ? mailboxes : null),
  lastKnownGoodAt: opts.lastKnownGoodAt || Date.now(),
});

// ---------------------------------------------------------------------------
// Suspicious empty mailbox result detection
// ---------------------------------------------------------------------------
describe('isSuspiciousEmptyMailboxResult', () => {
  it('returns false when server returns non-empty mailbox list', () => {
    const fresh = [mkMailbox('INBOX'), mkMailbox('Sent')];
    const cached = mkCachedEntry([mkMailbox('INBOX'), mkMailbox('Sent')]);
    expect(isSuspiciousEmptyMailboxResult(fresh, cached)).toBe(false);
  });

  it('returns true when server returns [] but prior cache had complete tree', () => {
    const cached = mkCachedEntry([mkMailbox('INBOX'), mkMailbox('Sent'), mkMailbox('Trash')]);
    expect(isSuspiciousEmptyMailboxResult([], cached)).toBe(true);
  });

  it('returns false when server returns [] for brand-new account (no prior cache)', () => {
    expect(isSuspiciousEmptyMailboxResult([], null)).toBe(false);
  });

  it('returns false when server returns [] and prior cache only had stub INBOX', () => {
    const cached = mkCachedEntry([mkMailbox('INBOX')]);
    // isMailboxTreeComplete returns false for single INBOX-only tree
    expect(isSuspiciousEmptyMailboxResult([], cached)).toBe(false);
  });

  it('returns true when server returns [] but lastKnownGoodMailboxes had data', () => {
    const cached = {
      mailboxes: [], // current cache is empty (already corrupted)
      fetchedAt: Date.now(),
      lastKnownGoodMailboxes: [mkMailbox('INBOX'), mkMailbox('Sent')],
      lastKnownGoodAt: Date.now() - 60000,
    };
    expect(isSuspiciousEmptyMailboxResult([], cached)).toBe(true);
  });

  it('returns false when freshMailboxes is null (fetch error, not empty result)', () => {
    const cached = mkCachedEntry([mkMailbox('INBOX'), mkMailbox('Sent')]);
    expect(isSuspiciousEmptyMailboxResult(null, cached)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suspicious empty email result detection
// ---------------------------------------------------------------------------
describe('isSuspiciousEmptyEmailResult', () => {
  it('returns false when server reports non-zero emails', () => {
    const cached = { totalEmails: 500 };
    expect(isSuspiciousEmptyEmailResult(100, cached, new Set())).toBe(false);
  });

  it('returns true when server returns 0 but cache had 500 emails', () => {
    const cached = { totalEmails: 500 };
    expect(isSuspiciousEmptyEmailResult(0, cached, new Set())).toBe(true);
  });

  it('returns true when server returns 0 but Maildir has saved emails', () => {
    const savedIds = new Set([1, 2, 3, 4, 5]);
    expect(isSuspiciousEmptyEmailResult(0, null, savedIds)).toBe(true);
  });

  it('returns true when server returns 0 with both cache and Maildir evidence', () => {
    const cached = { totalEmails: 200 };
    const savedIds = new Set([10, 20, 30]);
    expect(isSuspiciousEmptyEmailResult(0, cached, savedIds)).toBe(true);
  });

  it('returns false for brand-new account with no cache and no Maildir', () => {
    expect(isSuspiciousEmptyEmailResult(0, null, new Set())).toBe(false);
  });

  it('returns false when cached totalEmails is 0 and no Maildir data', () => {
    const cached = { totalEmails: 0 };
    expect(isSuspiciousEmptyEmailResult(0, cached, new Set())).toBe(false);
  });

  it('uses lastKnownGoodTotalEmails when totalEmails is missing', () => {
    const cached = { lastKnownGoodTotalEmails: 300 };
    expect(isSuspiciousEmptyEmailResult(0, cached, new Set())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mailbox tree completeness checks
// ---------------------------------------------------------------------------
describe('isMailboxTreeComplete', () => {
  it('returns false for empty array', () => {
    expect(isMailboxTreeComplete([])).toBe(false);
  });

  it('returns false for single INBOX-only mailbox', () => {
    expect(isMailboxTreeComplete([mkMailbox('INBOX')])).toBe(false);
  });

  it('returns true for INBOX + Sent', () => {
    expect(isMailboxTreeComplete([mkMailbox('INBOX'), mkMailbox('Sent')])).toBe(true);
  });

  it('returns true for single non-INBOX mailbox', () => {
    expect(isMailboxTreeComplete([mkMailbox('Sent')])).toBe(true);
  });

  it('counts children in tree', () => {
    const tree = [mkMailbox('INBOX', [mkMailbox('Subfolder')])];
    expect(countMailboxes(tree)).toBe(2);
    expect(isMailboxTreeComplete(tree)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: normal accounts with real non-empty results pass through
// ---------------------------------------------------------------------------
describe('regression: normal non-empty results are not flagged', () => {
  it('non-empty mailbox list is never suspicious', () => {
    const cached = mkCachedEntry([mkMailbox('INBOX'), mkMailbox('Sent'), mkMailbox('Trash')]);
    const fresh = [mkMailbox('INBOX'), mkMailbox('Sent')]; // fewer than cache (folder removed) — still not suspicious
    expect(isSuspiciousEmptyMailboxResult(fresh, cached)).toBe(false);
  });

  it('server with 1 email is never suspicious even if cache had 1000', () => {
    const cached = { totalEmails: 1000 };
    expect(isSuspiciousEmptyEmailResult(1, cached, new Set())).toBe(false);
  });

  it('legitimately empty account that was always empty is accepted', () => {
    const cached = { totalEmails: 0, lastKnownGoodTotalEmails: 0 };
    expect(isSuspiciousEmptyEmailResult(0, cached, new Set())).toBe(false);
  });
});
