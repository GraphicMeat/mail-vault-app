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
const settings = vi.hoisted(() => ({ cacheLimitMB: 128, hiddenAccounts: {}, autoDownloadAttachments: false }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => settings },
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
vi.mock('../api', () => ({ prefetchAttachments: vi.fn(async () => 0), fetchEmailLight: vi.fn() }));
vi.mock('../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));

const { AccountPipeline } = await import('../AccountPipeline');
const db = await import('../db');
const api = await import('../api');
const { syncNow, waitForSync } = await import('../syncService');

/** Let the microtask chain behind a resolved promise run to the end. */
const tick = () => new Promise(r => setTimeout(r, 0));
/** The worker loop yields 10ms between fetches and staggers its slots by 100ms. */
const browserTicks = (n) => new Promise(r => setTimeout(r, n * 50));

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

// Bodies first, attachments after: the attachment prefetch is handed the
// mailbox only once the body pass for it is over, and only when the setting
// asks for it. It runs newest-first on its own thread in Rust.
describe('AccountPipeline attachment prefetch', () => {
  // Not the active account: _finish's saved-id refresh is another test's concern.
  const account = { id: 'acc-2', email: 'me@mock.test', password: 'pw' };

  beforeEach(() => {
    vi.clearAllMocks();
    settings.autoDownloadAttachments = false;
  });

  it('hands the mailbox to the attachment prefetch once its bodies are cached', async () => {
    settings.autoDownloadAttachments = true;
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    await pipeline._finish('Sent');
    expect(api.prefetchAttachments).toHaveBeenCalledWith('acc-2', 'Sent');
  });

  it('leaves attachments alone when the setting is off', async () => {
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    await pipeline._finish('INBOX');
    expect(api.prefetchAttachments).not.toHaveBeenCalled();
  });

  // A body the server refuses (yoda's 907-909 in the e2e fixture; a real
  // mailbox's one corrupt message) keeps the retry loop alive for ever.
  // The attachments of every body that DID land must not wait behind it.
  it('prefetches once the first pass drains, while failed bodies still wait for a retry', async () => {
    settings.autoDownloadAttachments = true;
    api.fetchEmailLight.mockImplementation(async (_a, uid) => {
      if (uid === 2) throw new Error('Server cannot read that message');
      return { uid, attachments: [] };
    });
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2], 'INBOX');
    await browserTicks(6);

    expect(pipeline._retryQueue).toEqual([2]);
    expect(api.prefetchAttachments).toHaveBeenCalledTimes(1);
    expect(api.prefetchAttachments).toHaveBeenCalledWith('acc-2', 'INBOX');
    pipeline.destroy(); // clears the retry timer
  });

  it('still prefetches a mailbox whose bodies were already all cached', async () => {
    settings.autoDownloadAttachments = true;
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    await pipeline.startContentCaching([], 'INBOX');
    await tick();
    expect(api.prefetchAttachments).toHaveBeenCalledWith('acc-2', 'INBOX');

    // A pipeline is reused across account switches; each switch sweeps again.
    await pipeline.startContentCaching([], 'INBOX');
    expect(api.prefetchAttachments).toHaveBeenCalledTimes(2);
  });
});
