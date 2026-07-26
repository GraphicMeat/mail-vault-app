import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api/db so importing syncProbe doesn't drag in the Tauri-dependent chain.
const mockCheckMailboxStatus = vi.fn();
vi.mock('../api', () => ({
  checkMailboxStatus: (...args) => mockCheckMailboxStatus(...args),
}));
const mockGetEmailHeadersMeta = vi.fn();
vi.mock('../db', () => ({
  getEmailHeadersMeta: (...args) => mockGetEmailHeadersMeta(...args),
}));

const { mailboxIsUnchanged, invalidate } = await import('../syncProbe.js');

const ACCOUNT = { email: 'a@b.c' };
// Fully-cached mailbox: totalCached === totalEmails, so the partial-cache
// short-circuit doesn't fire and the server comparison is what's under test.
const FULL_META = {
  totalEmails: 100, totalCached: 100,
  uidValidity: 42, uidNext: 501, highestModseq: 900,
};

let acc = 0;
/** Fresh account id per case — the module's 10s ledger is process-global. */
const nextId = () => `acc${++acc}`;

beforeEach(() => {
  mockCheckMailboxStatus.mockReset();
  mockGetEmailHeadersMeta.mockReset();
  mockGetEmailHeadersMeta.mockResolvedValue(FULL_META);
});

describe('mailboxIsUnchanged — CONDSTORE servers', () => {
  it('is unchanged when HIGHESTMODSEQ matches', async () => {
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 100, uidValidity: 42, uidNext: 501, highestModseq: 900,
    });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r).toEqual({ unchanged: true, reason: 'modseq-match' });
  });

  it('detects a flag-only change that leaves every count identical', async () => {
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 100, uidValidity: 42, uidNext: 501, highestModseq: 901,
    });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r.unchanged).toBe(false);
    expect(r.reason).toBe('modseq-advanced');
  });
});

describe('mailboxIsUnchanged — servers without CONDSTORE', () => {
  const noModseqMeta = { ...FULL_META, highestModseq: null };

  it('is unchanged when both UIDNEXT and EXISTS match', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue(noModseqMeta);
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 100, uidValidity: 42, uidNext: 501, highestModseq: null,
    });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r).toEqual({ unchanged: true, reason: 'uidnext-exists-match' });
  });

  // The whole point of comparing UIDNEXT rather than the message count: one
  // arrival plus one expunge leaves EXISTS at 100, but UIDNEXT still moved.
  it('catches +1/-1 where the message count cancels out', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue(noModseqMeta);
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 100, uidValidity: 42, uidNext: 502, highestModseq: null,
    });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r.unchanged).toBe(false);
    expect(r.reason).toBe('uidnext-advanced');
  });

  it('catches an expunge with no arrival', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue(noModseqMeta);
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 99, uidValidity: 42, uidNext: 501, highestModseq: null,
    });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r.unchanged).toBe(false);
    expect(r.reason).toBe('exists-changed');
  });
});

describe('mailboxIsUnchanged — must not short-circuit', () => {
  it('syncs when UIDVALIDITY changed, even with everything else level', async () => {
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 100, uidValidity: 43, uidNext: 501, highestModseq: 900,
    });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r.unchanged).toBe(false);
    expect(r.reason).toBe('uidvalidity-changed');
  });

  // A restored/migrated mailbox: server is quiet, but the cache is short and
  // still needs the daemon backfill. Skipping here would strand it.
  it('syncs when the cache holds fewer messages than the mailbox', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue({ ...FULL_META, totalCached: 500, totalEmails: 15000 });
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r).toEqual({ unchanged: false, reason: 'partial-cache' });
    expect(mockCheckMailboxStatus).not.toHaveBeenCalled();
  });

  it('syncs when there is no cache at all', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue(null);
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r).toEqual({ unchanged: false, reason: 'no-cache' });
  });

  it('syncs when the probe itself fails — never a missed sync', async () => {
    mockCheckMailboxStatus.mockRejectedValue(new Error('connection refused'));
    const r = await mailboxIsUnchanged(ACCOUNT, nextId(), 'INBOX');
    expect(r.unchanged).toBe(false);
    expect(r.reason).toBe('probe-failed');
  });
});

describe('probe ledger', () => {
  it('skips the round trip when probed moments ago, until invalidated', async () => {
    const id = nextId();
    mockCheckMailboxStatus.mockResolvedValue({
      exists: 100, uidValidity: 42, uidNext: 501, highestModseq: 900,
    });

    await mailboxIsUnchanged(ACCOUNT, id, 'INBOX'); // does not mark by itself
    expect(mockCheckMailboxStatus).toHaveBeenCalledTimes(1);

    const { markVerified } = await import('../syncProbe.js');
    markVerified(id, 'INBOX');

    const second = await mailboxIsUnchanged(ACCOUNT, id, 'INBOX');
    expect(second).toEqual({ unchanged: true, reason: 'probed-recently' });
    expect(mockCheckMailboxStatus).toHaveBeenCalledTimes(1); // no second call

    invalidate(id, 'INBOX');
    await mailboxIsUnchanged(ACCOUNT, id, 'INBOX');
    expect(mockCheckMailboxStatus).toHaveBeenCalledTimes(2);
  });
});
