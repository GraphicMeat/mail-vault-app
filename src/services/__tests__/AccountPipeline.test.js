import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({
      activeAccountId: 'acc-1',
      activeMailbox: 'INBOX',
      addToCache: vi.fn(),
    }),
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
    }),
  },
}));
vi.mock('../db', () => ({
  getSavedEmailIds: () => Promise.resolve(new Set()),
  getArchivedEmailIds: () => Promise.resolve(new Set()),
  getEmailHeadersMeta: vi.fn(),
  getEmailHeadersPartial: vi.fn(),
}));
vi.mock('../syncService', () => ({
  syncNow: vi.fn(),
  waitForSync: vi.fn(),
}));
vi.mock('../transport', () => ({ getDaemonHealth: () => ({ alive: true }) }));
vi.mock('../api', () => ({}));
vi.mock('../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));

const { AccountPipeline } = await import('../AccountPipeline');
const db = await import('../db');
const { syncNow, waitForSync } = await import('../syncService');

/** Let the microtask chain behind a resolved promise run to the end. */
const tick = () => new Promise(r => setTimeout(r, 0));

describe('AccountPipeline memory cleanup', () => {
  it('clears _lastLoadedEmails and _graphIdMap on construction', () => {
    const pipeline = new AccountPipeline(
      { email: 'test@example.com' },
      'acc-1',
      { concurrency: 1 }
    );

    expect(pipeline._lastLoadedEmails).toBeNull();
    expect(pipeline._graphIdMap).toBeNull();
  });

  it('clears _lastLoadedEmails after _finish()', async () => {
    const pipeline = new AccountPipeline(
      { email: 'test@example.com' },
      'acc-1',
      { concurrency: 1 }
    );

    // Simulate having loaded headers
    pipeline._lastLoadedEmails = [{ uid: 1 }, { uid: 2 }];
    pipeline._graphIdMap = new Map([[1, 'graph-id-1']]);

    // Call _finish directly
    await pipeline._finish();

    expect(pipeline._lastLoadedEmails).toBeNull();
    expect(pipeline._graphIdMap).toBeNull();
  });

  it('clears data on destroy()', () => {
    const pipeline = new AccountPipeline(
      { email: 'test@example.com' },
      'acc-1',
      { concurrency: 1 }
    );

    pipeline._lastLoadedEmails = [{ uid: 1 }];
    pipeline._graphIdMap = new Map([[1, 'id']]);

    pipeline.destroy();

    expect(pipeline._destroyed).toBe(true);
  });
});

describe('AccountPipeline daemon headers', () => {
  const account = { id: 'acc-1', email: 'me@mock.test', password: 'pw' };

  beforeEach(() => {
    vi.clearAllMocks();
    syncNow.mockResolvedValue({ started: true, accountId: 'acc-1', mailbox: 'INBOX', ticket: 42 });
  });

  it('a warm cache paints now and reloads when its sync lands', async () => {
    let landSync;
    waitForSync.mockReturnValue(new Promise(r => { landSync = r; }));
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 2, totalEmails: 3 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: [{ uid: 1 }, { uid: 2 }] });

    const onHeadersRefreshed = vi.fn();
    const pipeline = new AccountPipeline(account, { onHeadersRefreshed });

    const raced = await Promise.race([
      pipeline.loadHeaders('INBOX').then(() => 'painted'),
      new Promise(r => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(raced).toBe('painted');
    expect(pipeline._lastLoadedEmails).toHaveLength(2);
    expect(waitForSync).toHaveBeenCalledWith(42, 30000);

    const three = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 3, totalEmails: 3 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: three });
    landSync({ success: true });
    await tick();

    expect(onHeadersRefreshed).toHaveBeenCalledTimes(1);
    expect(onHeadersRefreshed).toHaveBeenCalledWith('INBOX', three, { success: true });
    expect(pipeline._lastLoadedEmails).toHaveLength(3);
  });

  it('a cold cache waits for the sync and reads once', async () => {
    const four = [{ uid: 1 }, { uid: 2 }, { uid: 3 }, { uid: 4 }];
    db.getEmailHeadersMeta.mockResolvedValueOnce(null); // nothing cached yet
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 4, totalEmails: 4 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: four });
    waitForSync.mockImplementation(
      () => new Promise(r => setTimeout(() => r({ success: true }), 20))
    );

    const onHeadersRefreshed = vi.fn();
    const pipeline = new AccountPipeline(account, { onHeadersRefreshed });
    await pipeline.loadHeaders('INBOX');

    expect(pipeline._lastLoadedEmails).toHaveLength(4);
    expect(onHeadersRefreshed).not.toHaveBeenCalled();
    expect(waitForSync).toHaveBeenCalledTimes(1);
    expect(waitForSync).toHaveBeenCalledWith(42, 30000);
  });

  it('a reload that times out keeps the painted headers', async () => {
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 2, totalEmails: 2 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: [{ uid: 1 }, { uid: 2 }] });
    waitForSync.mockRejectedValue(new Error('Sync timed out'));

    const onHeadersRefreshed = vi.fn();
    const onError = vi.fn();
    const pipeline = new AccountPipeline(account, { onHeadersRefreshed, onError });

    await pipeline.loadHeaders('INBOX');
    await tick();

    expect(pipeline._lastLoadedEmails).toHaveLength(2);
    expect(onHeadersRefreshed).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a destroyed pipeline ignores a late reload', async () => {
    let landSync;
    waitForSync.mockReturnValue(new Promise(r => { landSync = r; }));
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 2, totalEmails: 2 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: [{ uid: 1 }, { uid: 2 }] });

    const onHeadersRefreshed = vi.fn();
    const pipeline = new AccountPipeline(account, { onHeadersRefreshed });

    await pipeline.loadHeaders('INBOX');
    pipeline.destroy();
    landSync({ success: true });
    await tick();

    expect(onHeadersRefreshed).not.toHaveBeenCalled();
  });
});
