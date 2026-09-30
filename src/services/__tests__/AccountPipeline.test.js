import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies
const mail = vi.hoisted(() => ({ state: {
  activeAccountId: 'acc-1', activeMailbox: 'INBOX', emails: [], totalEmails: 0,
  addToCache: vi.fn(), updateSortedEmails: vi.fn(), archivedEmailIds: new Set(),
} }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => mail.state,
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));
const settings = vi.hoisted(() => ({ cacheLimitMB: 128, hiddenAccounts: {}, autoDownloadAttachments: false }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => settings },
}));
vi.mock('../db', () => ({
  getVaultUidSets: () => Promise.resolve({ saved: new Set(), archived: new Set() }),
  getEmailHeadersMeta: vi.fn(),
  getEmailHeadersPartial: vi.fn(),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../syncService', () => ({
  syncNow: vi.fn(),
  waitForSync: vi.fn(),
  // The daemon header path builds its sync account through this; the field
  // shape itself is pinned in syncService.test.js, not here.
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
}));
vi.mock('../transport', () => ({ getDaemonHealth: () => ({ alive: true }) }));
const graph = vi.hoisted(() => ({
  order: [],
  listFolders: null,
  listMessages: null,
  adopt: null,
}));
vi.mock('../api', () => ({
  prefetchAttachments: vi.fn(async () => 0),
  fetchEmailLight: vi.fn(),
  graphListFolders: (...a) => graph.listFolders(...a),
}));
vi.mock('../cacheManager', () => ({ listGraphMessages: (...a) => graph.listMessages(...a) }));
vi.mock('../workflows/adoptGraphFolderKeys', () => ({
  adoptGraphFolderKeysFromListing: (...a) => graph.adopt(...a),
}));
vi.mock('../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
}));
// The real module pulls in mailStore, db, transport, graphConfig and more —
// already exercised by selectEmail's own gone-row tests. Here only the
// interaction matters: does the worker loop hand a gone uid to the shared
// prune helper instead of retrying it.
const mockPruneIfGone = vi.fn();
vi.mock('../workflows/messageMutations', () => ({
  _pruneIfGone: (...a) => mockPruneIfGone(...a),
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
  beforeEach(() => {
    mail.state.activeAccountId = 'acc-1';
    mail.state.activeMailbox = 'INBOX';
    mail.state.emails = [];
    mail.state.totalEmails = 0;
  });

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

  it('never saves a merged unified list as one account mailbox', async () => {
    mail.state.activeMailbox = 'UNIFIED';
    mail.state.emails = [
      {uid:1,_accountId:'acc-1',from:{address:'inga@fenixera.lt'}},
      {uid:2,_accountId:'acc-2',to:[{address:'donatas@domasta.lt'}]},
    ];
    const pipeline = new AccountPipeline({id:'acc-1',email:'prime@graphicmeat.com'});

    await pipeline._finish('INBOX');

    expect(db.saveEmailHeaders).not.toHaveBeenCalled();
  });

  // A branch listing's activeMailbox is its root, a real folder, so the
  // unified guard above (activeMailbox is never a folder there) let it
  // through: the rows of every folder in the branch, and the branch's total,
  // were saved into the root folder's header cache.
  it('never saves a branch listing as its root folder', async () => {
    db.saveEmailHeaders.mockClear();
    mail.state.activeMailbox = 'Kunden';
    mail.state.mailboxScope = { root: 'Kunden', paths: ['Kunden', 'Kunden/Company XY'] };
    mail.state.emails = [
      { uid: 9401, _accountId: 'acc-1', _mailbox: 'Kunden' },
      { uid: 9411, _accountId: 'acc-1', _mailbox: 'Kunden/Company XY' },
    ];
    mail.state.totalEmails = 2;
    const pipeline = new AccountPipeline({ id: 'acc-1', email: 'prime@graphicmeat.com' });

    try {
      await pipeline._finish('Kunden');
    } finally {
      mail.state.mailboxScope = null;
    }

    expect(db.saveEmailHeaders).not.toHaveBeenCalled();
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

  it('keeps only uid and date from a loaded header set', async () => {
    // The whole row used to be retained, which is a second copy of the mailbox
    // in the webview for as long as the body phase runs. Nothing downstream
    // reads more than these two fields.
    const fat = [{
      uid: 7, date: '2026-01-02T03:04:05Z', subject: 'x'.repeat(200),
      from: 'a@b.test', to: ['c@d.test'], flags: ['\\Seen'], snippet: 'y'.repeat(500),
    }];
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 1, totalEmails: 1 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: fat });
    waitForSync.mockRejectedValue(new Error('no sync in this test'));

    const pipeline = new AccountPipeline(account);
    await pipeline.loadHeaders('INBOX');

    expect(pipeline._lastLoadedEmails).toEqual([{ uid: 7, date: '2026-01-02T03:04:05Z' }]);
  });

  it('falls back to internalDate when a row carries no date', async () => {
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 1, totalEmails: 1 });
    db.getEmailHeadersPartial.mockResolvedValue({ emails: [{ uid: 9, internalDate: '2026-02-03T00:00:00Z' }] });
    waitForSync.mockRejectedValue(new Error('no sync in this test'));

    const pipeline = new AccountPipeline(account);
    await pipeline.loadHeaders('INBOX');

    expect(pipeline._lastLoadedEmails).toEqual([{ uid: 9, date: '2026-02-03T00:00:00Z' }]);
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

// A5: the server proved a uid is gone (MessageGoneError, `messageGone: true`).
// Before this fix the worker loop caught every error the same way and pushed
// it onto _retryQueue, which _scheduleRetry backs off forever (capped at
// 120s) — a deleted message was refetched 47 times in one day's log, each one
// paying the full slow-Gmail body-fetch cost for an answer the server had
// already given.
describe('AccountPipeline background fetch — a uid the server no longer holds', () => {
  const account = { id: 'acc-2', email: 'me@mock.test', password: 'pw' };

  function goneError(uid, mailbox = 'INBOX') {
    const err = new Error(`Message UID ${uid} is no longer in ${mailbox}`);
    err.messageGone = true;
    err.uid = uid;
    err.mailbox = mailbox;
    return err;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPruneIfGone.mockResolvedValue(true);
  });

  it('fetches a gone uid exactly once, never retries it, and still finishes', async () => {
    vi.useFakeTimers();
    try {
      api.fetchEmailLight.mockRejectedValue(goneError(46856));
      const onComplete = vi.fn();
      const pipeline = new AccountPipeline(account, { concurrency: 1, onComplete });

      pipeline.startContentCaching([46856], 'INBOX');
      // Past every step of the backoff ladder (3s, 6s, 12s, ... capped 120s) —
      // if the fix regresses, this alone would be enough time for several
      // retries.
      await vi.advanceTimersByTimeAsync(130000);

      expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
      expect(mockPruneIfGone).toHaveBeenCalledWith(
        expect.objectContaining({ messageGone: true, uid: 46856 }),
        46856,
        { accountId: 'acc-2', mailbox: 'INBOX' },
      );
      expect(pipeline._retryQueue).toEqual([]);
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still retries a uid whose fetch merely failed, unaffected by the gone check', async () => {
    // Every other caller of _pruneIfGone gets this same answer for a failure
    // that proves nothing about the server — false, not pruned.
    mockPruneIfGone.mockResolvedValue(false);
    api.fetchEmailLight.mockRejectedValue(new Error('Server refused UID FETCH: no response'));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });

    pipeline.startContentCaching([7], 'INBOX');
    await browserTicks(6);

    expect(pipeline._retryQueue).toEqual([7]);
    expect(mockPruneIfGone).toHaveBeenCalledWith(expect.any(Error), 7, { accountId: 'acc-2', mailbox: 'INBOX' });
    pipeline.destroy();
  });
});

// The background pass only puts bodies on disk. Holding each one in the
// webview's body cache too kept up to 128 MB of mail nobody had opened.
describe('AccountPipeline background body fetch', () => {
  const account = { id: 'acc-2', email: 'me@mock.test', password: 'pw' };

  beforeEach(() => {
    vi.clearAllMocks();
    settings.autoDownloadAttachments = false;
  });

  afterEach(() => {
    mail.state.activeAccountId = 'acc-1';
    mail.state.activeMailbox = 'INBOX';
    mail.state.emails = [];
  });

  it('leaves the webview body cache alone, and still marks the row as having attachments', async () => {
    const row = { uid: 1 };
    mail.state.activeAccountId = 'acc-2';
    mail.state.activeMailbox = 'INBOX';
    mail.state.emails = [row];
    api.fetchEmailLight.mockResolvedValue({ uid: 1, hasAttachments: true, html: '<p>body</p>' });
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1], 'INBOX');
    await browserTicks(6);

    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
    expect(mail.state.addToCache).not.toHaveBeenCalled();
    expect(row.hasAttachments).toBe(true);
    pipeline.destroy();
    mail.state.emails = [];
  });

  // A uid names a message only inside one (account, mailbox). The pass runs for
  // acc-2's INBOX in the background while the screen shows something else; a
  // row of that other view sharing the number is another message and must not
  // get the paperclip.
  it("marks acc-2's INBOX row only, not another account's row sharing the uid in All inboxes", async () => {
    const mine = { uid: 1, _accountId: 'acc-2', _mailbox: 'INBOX' };
    const theirs = { uid: 1, _accountId: 'acc-1', _mailbox: 'INBOX' };
    mail.state.activeMailbox = 'UNIFIED';
    mail.state.emails = [theirs, mine];
    api.fetchEmailLight.mockResolvedValue({ uid: 1, hasAttachments: true, html: '<p>body</p>' });
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1], 'INBOX');
    await browserTicks(6);

    expect(mine.hasAttachments).toBe(true);
    expect(theirs.hasAttachments).toBeUndefined();
    pipeline.destroy();
    mail.state.emails = [];
  });

  it("leaves the row of acc-1's Archive alone while acc-2's INBOX downloads", async () => {
    const archiveRow = { uid: 1 };
    mail.state.activeAccountId = 'acc-1';
    mail.state.activeMailbox = 'Archive';
    mail.state.emails = [archiveRow];
    api.fetchEmailLight.mockResolvedValue({ uid: 1, hasAttachments: true, html: '<p>body</p>' });
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1], 'INBOX');
    await browserTicks(6);

    expect(archiveRow.hasAttachments).toBeUndefined();
    pipeline.destroy();
    mail.state.activeAccountId = 'acc-1';
    mail.state.activeMailbox = 'INBOX';
    mail.state.emails = [];
  });

  // Track H: the download-ahead fetch says so, so the daemon keeps its body
  // only inside the download window. An opened message says 'open'.
  it("fetches ahead as 'backfill' on the background lane", async () => {
    api.fetchEmailLight.mockResolvedValue({ uid: 1 });
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1], 'INBOX');
    await browserTicks(6);

    expect(api.fetchEmailLight).toHaveBeenCalledWith(account, 1, 'INBOX', 'acc-2', { background: true, intent: 'backfill' });
    pipeline.destroy();
  });
});

describe('AccountPipeline Graph header load', () => {
  const graphAccount = { id: 'acc-3', email: 'leia@mock.test', oauth2Transport: 'graph', oauth2AccessToken: 'tok' };
  const listing = [{ id: 'f2', displayName: 'Gesendete Elemente', wellKnownName: 'sentitems', storageKey: 'Sent' }];

  beforeEach(() => {
    graph.order = [];
    graph.listFolders = vi.fn(async () => { graph.order.push('listFolders'); return listing; });
    graph.listMessages = vi.fn(async () => { graph.order.push('listMessages'); return { headers: [] }; });
    graph.adopt = vi.fn(async () => { graph.order.push('adopt'); });
  });

  // A folder still stored under the server's word for it must be adopted
  // before anything writes under the storage key, or the pipeline caches
  // headers into a sidecar the old directory never joins.
  it('adopts the listing before it lists any message', async () => {
    const pipeline = new AccountPipeline(graphAccount, { concurrency: 1 });
    await pipeline._loadHeadersGraph('Sent');

    expect(graph.adopt).toHaveBeenCalledWith(graphAccount, listing);
    expect(graph.order).toEqual(['listFolders', 'adopt', 'listMessages']);
  });
});

// The daily download limit governs the download-ahead pass. The daemon refuses
// a `backfill` fetch once the day's allowance is spent (`LimitReachedError`);
// the pipeline must not retry that (the message is fine), and must not hold the
// other accounts' cascade hostage for a day either: it sleeps until the next
// UTC day, keeps its queue, and picks it up again there.
describe('AccountPipeline download-ahead at the daily limit', () => {
  const account = { id: 'acc-4', email: 'han@mock.test', password: 'pw' };
  const HOUR = 3600_000;

  function limitError(resumeAfterMs) {
    const err = new Error('Daily download limit reached');
    err.limitReached = true;
    err.limitBytes = 2000 * 1024 * 1024;
    err.resumeAfterMs = resumeAfterMs;
    return err;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPruneIfGone.mockResolvedValue(false);
    settings.autoDownloadAttachments = false;
  });
  afterEach(() => vi.useRealTimers());

  it('stops at the first refusal, keeps the queue in order, and hands the cascade on', async () => {
    api.fetchEmailLight.mockRejectedValue(limitError(Date.now() + 2 * HOUR));
    const onComplete = vi.fn();
    const pipeline = new AccountPipeline(account, { concurrency: 1, onComplete });

    pipeline.startContentCaching([1, 2, 3], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
    expect(pipeline._queue).toEqual([1, 2, 3]);
    expect(pipeline._retryQueue).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(pipeline.state.isRunning).toBe(false);
    // The retry ladder (3s, 6s ... capped 120s) never runs for a limit.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
    pipeline.destroy();
  });

  it('picks the queue up again after the reset and finishes it', async () => {
    api.fetchEmailLight.mockRejectedValueOnce(limitError(Date.now() + 2 * HOUR));
    const onComplete = vi.fn();
    const pipeline = new AccountPipeline(account, { concurrency: 1, onComplete });
    pipeline.startContentCaching([1, 2], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);

    api.fetchEmailLight.mockResolvedValue({ uid: 1 });
    await vi.advanceTimersByTimeAsync(2 * HOUR + 60_000);

    expect(api.fetchEmailLight.mock.calls.map(c => c[1])).toEqual([1, 1, 2]);
    expect(pipeline._queue).toEqual([]);
    expect(pipeline._phase).toBe('done');
    expect(onComplete).toHaveBeenCalledTimes(2); // the hand-off, then the real finish
    pipeline.destroy();
  });

  it('several slots hitting the limit at once arm one timer and lose no uid', async () => {
    api.fetchEmailLight.mockRejectedValue(limitError(Date.now() + HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 3 });
    pipeline.startContentCaching([1, 2, 3, 4, 5], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);

    expect([...pipeline._queue].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(pipeline._retryQueue).toEqual([]);
    expect(pipeline._activeSlots).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    pipeline.destroy();
  });

  it('coming back online or switching accounts does not wake a pass that sleeps for the limit', async () => {
    api.fetchEmailLight.mockRejectedValue(limitError(Date.now() + HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);

    pipeline.pause();
    pipeline.resume('INBOX');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
    pipeline.destroy();
  });

  it('new uids that arrive while it sleeps join the queue and launch nothing', async () => {
    api.fetchEmailLight.mockRejectedValue(limitError(Date.now() + HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);

    pipeline.startContentCaching([2, 9], 'INBOX');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pipeline._queue).toEqual([1, 2, 9]);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
    pipeline.destroy();
  });

  // A uid names a message only inside one mailbox. Merging another folder's
  // uids into the sleeping queue ran them against the first folder at reset.
  it('uids of another mailbox that arrive while it sleeps replace the queue, and run in that mailbox after the reset', async () => {
    api.fetchEmailLight.mockResolvedValue({});
    api.fetchEmailLight
      .mockRejectedValueOnce(new Error('connection reset')) // uid 1: an ordinary failure, parked for a retry
      .mockRejectedValueOnce(limitError(Date.now() + HOUR)); // uid 2: the limit
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2, 3], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(2);
    expect(pipeline._retryQueue).toEqual([1]);

    pipeline.startContentCaching([7, 8], 'Archive');
    expect(pipeline._queue).toEqual([7, 8]);
    expect(pipeline._retryQueue).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(HOUR + 60_000);
    expect(api.fetchEmailLight.mock.calls.slice(2).map(c => [c[1], c[2]])).toEqual([[7, 'Archive'], [8, 'Archive']]);
    expect(pipeline._phase).toBe('done');
    pipeline.destroy();
  });

  it('uids of the same mailbox still join the sleeping queue (negative control)', async () => {
    api.fetchEmailLight.mockResolvedValue({});
    api.fetchEmailLight.mockRejectedValueOnce(limitError(Date.now() + HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2], 'Archive');
    await vi.advanceTimersByTimeAsync(1000);

    pipeline.startContentCaching([2, 9], 'Archive');
    expect(pipeline._queue).toEqual([1, 2, 9]);
    await vi.advanceTimersByTimeAsync(HOUR + 60_000);
    expect(api.fetchEmailLight.mock.calls.slice(1).map(c => [c[1], c[2]])).toEqual([[1, 'Archive'], [2, 'Archive'], [9, 'Archive']]);
    pipeline.destroy();
  });

  // The reset (or a wake from Settings) can come while another account is
  // active or the app is offline; `onAccountSwitch` and `resumeAll` then
  // resume with 'INBOX', which must not redirect a queue that slept elsewhere.
  it.each([
    ['the reset passes', async () => { await vi.advanceTimersByTimeAsync(HOUR + 60_000); }],
    ['Settings wake it', async (pipeline) => { pipeline.wakeFromLimit(); await vi.advanceTimersByTimeAsync(1000); }],
  ])('a pass paused while asleep runs its queue in its own mailbox on resume (%s)', async (_label, wake) => {
    api.fetchEmailLight.mockResolvedValue({});
    api.fetchEmailLight.mockRejectedValueOnce(limitError(Date.now() + HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2], 'Archive');
    await vi.advanceTimersByTimeAsync(1000);

    pipeline.pause();
    await wake(pipeline);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);

    pipeline.resume('INBOX');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchEmailLight.mock.calls.slice(1).map(c => [c[1], c[2]])).toEqual([[1, 'Archive'], [2, 'Archive']]);
    pipeline.destroy();
  });

  // Turning the cap off or raising the limit in Settings releases the sleep
  // at once instead of at the next UTC day.
  it('wakeFromLimit ends the sleep now and finishes the queue in its mailbox', async () => {
    api.fetchEmailLight.mockResolvedValue({});
    api.fetchEmailLight.mockRejectedValueOnce(limitError(Date.now() + 5 * HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1, 2], 'Archive');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);

    pipeline.wakeFromLimit();
    expect(pipeline._limitTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.fetchEmailLight.mock.calls.map(c => [c[1], c[2]])).toEqual([[1, 'Archive'], [1, 'Archive'], [2, 'Archive']]);
    expect(pipeline._phase).toBe('done');
    // The old reset timer is gone: nothing is fetched again at the reset.
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(3);
    pipeline.destroy();
  });

  it('wakeFromLimit does nothing to a pipeline that is not asleep, or is destroyed', async () => {
    api.fetchEmailLight.mockResolvedValue({});
    const idle = new AccountPipeline(account, { concurrency: 1 });
    idle.wakeFromLimit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchEmailLight).not.toHaveBeenCalled();

    api.fetchEmailLight.mockRejectedValueOnce(limitError(Date.now() + HOUR));
    const gone = new AccountPipeline(account, { concurrency: 1 });
    gone.startContentCaching([1], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);
    gone.destroy();
    gone.wakeFromLimit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
  });

  it('a destroyed pipeline never wakes up', async () => {
    api.fetchEmailLight.mockRejectedValue(limitError(Date.now() + HOUR));
    const pipeline = new AccountPipeline(account, { concurrency: 1 });
    pipeline.startContentCaching([1], 'INBOX');
    await vi.advanceTimersByTimeAsync(1000);

    pipeline.destroy();
    api.fetchEmailLight.mockResolvedValue({ uid: 1 });
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
