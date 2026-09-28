/**
 * What the active account's body pipeline is allowed to fetch.
 *
 * Two values used to come straight off the store, and in All Inboxes both were
 * wrong: `emails` holds EVERY account's rows, and `activeMailbox` is the
 * literal 'UNIFIED'. The app logged the result on every unified session —
 *
 *   [CMD] imap_get_email_light: FAILED uid=910 mailbox=UNIFIED
 *     Failed to fetch email: SELECT UNIFIED failed: [NONEXISTENT] Mailbox does not exist
 *
 * — so no body was ever cached in that view, and each refused uid went back on
 * the retry queue for the life of the session.
 *
 * A uid names a message only inside one (account, mailbox), so this is the
 * same class of bug as the unified delete/undo work: a spanning view's
 * `activeMailbox` is not a folder, and its rows are not all yours.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startContentCaching = vi.fn(() => Promise.resolve());
const resume = vi.fn();
const loadHeaders = vi.fn(() => Promise.resolve());

vi.mock('../AccountPipeline', () => ({
  AccountPipeline: class {
    constructor() {
      this._destroyed = false;
      this._activeSlots = 0;
      this.startContentCaching = startContentCaching;
      this.resume = resume;
      this.loadHeaders = loadHeaders;
    }
    destroy() { this._destroyed = true; }
    waitForComplete() { return Promise.resolve(); }
  },
}));

vi.mock('../authUtils', () => ({ hasValidCredentials: () => true, ensureFreshToken: (a) => Promise.resolve(a) }));

vi.mock('../api', () => ({ fetchMailboxes: vi.fn().mockResolvedValue([]) }));

const store = vi.hoisted(() => ({ state: {} }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => store.state, setState: vi.fn(), subscribe: () => () => {} },
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ hiddenAccounts: {}, localCacheDurationMonths: 0, cacheLimitMB: 128 }),
  },
}));

vi.mock('../db', () => ({
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getCachedMailboxes: vi.fn().mockResolvedValue(null),
}));

vi.mock('../graphConfig', () => ({
  isGraphAccount: () => false,
  graphFoldersToMailboxes: () => [],
}));

vi.mock('../../utils/sentFolder', async (importOriginal) => ({
  ...(await importOriginal()),
  waitForSentMailboxPath: vi.fn().mockResolvedValue('Sent'),
}));

const { pipelineManager } = await import('../EmailPipelineManager');
const db = await import('../db');
const api = await import('../api');

const LUKE = { id: 'luke', email: 'luke@x' };
const YODA = { id: 'yoda', email: 'yoda@x' };

/** A unified row: stamped with the account and the folder resolved for it. */
const uRow = (uid, accountId, mailbox) => ({
  uid, _accountId: accountId, _mailbox: mailbox, date: '2026-09-01T10:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  pipelineManager.pipelines.clear();
  pipelineManager._activeAccountId = null;
  pipelineManager._contentCascadeDone.clear();
  // The two fan-outs this spec is not about. Left live they reach db and the
  // network on a timer and make the assertions below race them.
  pipelineManager._loadSentHeaders = vi.fn();
  pipelineManager._startBackgroundHeadersOnly = vi.fn();
});

describe('the active account pipeline in a view that spans mailboxes', () => {
  it('fetches its own account\'s uids from a real folder, never "UNIFIED"', async () => {
    store.state = {
      accounts: [LUKE, YODA],
      activeMailbox: 'UNIFIED',
      emails: [
        uRow(1, 'luke', 'INBOX'),
        uRow(2, 'luke', 'INBOX'),
        uRow(910, 'yoda', 'INBOX'),
      ],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    expect(startContentCaching).toHaveBeenCalledTimes(1);
    const [uids, mailbox] = startContentCaching.mock.calls[0];
    // yoda's 910 is not luke's to fetch — a uid names a message only inside
    // one (account, mailbox), so fetching it against luke reads a different
    // message or nothing at all.
    expect(uids).toEqual([1, 2]);
    expect(mailbox).toBe('INBOX');
    expect(mailbox).not.toBe('UNIFIED');
  });

  it('takes the folder from the rows, so a namespaced server gets its own path', async () => {
    // Dovecot/Hostinger resolve the unified folder to `INBOX.…` per account;
    // loadUnifiedInbox stamps that resolved path on every row it builds.
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'UNIFIED',
      emails: [uRow(4, 'luke', 'INBOX.Archive')],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    expect(startContentCaching).toHaveBeenCalledWith([4], 'INBOX.Archive');
  });

  it('leaves a single-folder view exactly as it was', async () => {
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'Archive',
      emails: [{ uid: 11, date: '2026-09-01T10:00:00Z' }, { uid: 12, date: '2026-09-01T10:00:00Z' }],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    // No `_accountId` on these rows and none needed: one folder, one account.
    expect(startContentCaching).toHaveBeenCalledWith([11, 12], 'Archive');
  });

  // A branch listing (loadSubtree) is the other view that spans mailboxes: its
  // `activeMailbox` is the branch root, a real folder, but the rows come from
  // every folder under it. Fetching them all from the root asked the server for
  // uids the root does not hold, and each "not here" answer pruned the row and
  // took one off the branch's count: "1 emails" over six rows on screen.
  it('fetches only the branch root\'s own rows in a branch listing, from the root', async () => {
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'Kunden',
      mailboxScope: { root: 'Kunden', paths: ['Kunden', 'Kunden/Company XY', 'Kunden/Company XY/Invoices'] },
      emails: [
        uRow(9401, 'luke', 'Kunden'),
        uRow(9411, 'luke', 'Kunden/Company XY'),
        uRow(9421, 'luke', 'Kunden/Company XY/Invoices'),
      ],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    expect(startContentCaching).toHaveBeenCalledWith([9401], 'Kunden');
  });

  it('reuses an idle pipeline against the resolved folder, not the literal', async () => {
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'UNIFIED',
      emails: [uRow(1, 'luke', 'INBOX')],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');
    await pipelineManager.startActiveAccountPipeline('luke');

    // The second call reuses the live pipeline and resumes it — that path read
    // `activeMailbox` too.
    expect(resume).toHaveBeenCalledWith('INBOX');
    expect(resume).not.toHaveBeenCalledWith('UNIFIED');
  });
});

// Unknown is not "nothing saved". The old getter answered a failed vault read
// with an empty Set, so every cached INBOX body was queued for a re-fetch.
describe('the content cascade on an unknown vault read', () => {
  const idlePipeline = () => ({
    _destroyed: false, _phase: 'idle', _lastLoadedEmails: [{ uid: 5, date: '2026-09-01T10:00:00Z' }],
    startContentCaching, waitForComplete: () => Promise.resolve(),
  });

  it('skips the account, leaves it un-walked for the next cascade, and lets the next cascade run', async () => {
    store.state = { accounts: [LUKE, YODA], activeMailbox: 'INBOX', emails: [], savedEmailIds: new Set() };
    pipelineManager._activeAccountId = 'luke';
    pipelineManager._backgroundContentRunning = false;
    pipelineManager.pipelines.set('yoda', idlePipeline());
    db.getVaultUidSets.mockResolvedValueOnce(null);

    await pipelineManager._startBackgroundContentPipelines();

    expect(startContentCaching).not.toHaveBeenCalled();
    expect(pipelineManager._contentCascadeDone.has('yoda')).toBe(false);
    expect(pipelineManager._backgroundContentRunning).toBe(false);

    // The next cascade, with a known answer, walks it.
    await pipelineManager._startBackgroundContentPipelines();
    expect(startContentCaching).toHaveBeenCalledWith([5], 'INBOX');
    expect(pipelineManager._contentCascadeDone.has('yoda')).toBe(true);
  });

  it('fetches nothing for a header refresh when the vault read is unknown', async () => {
    store.state = { accounts: [LUKE, YODA], activeMailbox: 'INBOX', emails: [], savedEmailIds: new Set(), getSentMailboxPath: () => 'Sent' };
    pipelineManager._activeAccountId = 'luke';
    pipelineManager._contentCascadeDone.add('yoda');
    db.getVaultUidSets.mockResolvedValueOnce(null);

    await pipelineManager._onHeadersRefreshed(YODA, idlePipeline(), 'INBOX', [{ uid: 5, date: '2026-09-01T10:00:00Z' }]);

    expect(startContentCaching).not.toHaveBeenCalled();
  });
});

// Every account's Sent was read at the ACTIVE account's path, and only the
// active account's reached the store — so All inboxes threaded no one's
// replies but the active account's, and a Dovecot account beside a Gmail one
// was asked for `[Gmail]/Sent Mail`.
describe('Sent headers for an account that is not the active one', () => {
  const loadSentHeaders = vi.fn();
  // The real method: beforeEach stubs the instance's own.
  const loadSent = (account, pipeline) =>
    Object.getPrototypeOf(pipelineManager)._loadSentHeaders.call(pipelineManager, account, pipeline);
  const livePipeline = () => ({ _destroyed: false, loadHeaders: vi.fn(() => Promise.resolve()) });

  const state = (over = {}) => ({
    accounts: [LUKE, YODA],
    activeAccountId: 'luke',
    activeMailbox: 'INBOX',
    unifiedFolder: 'INBOX',
    emails: [],
    savedEmailIds: new Set(),
    loadSentHeaders,
    // The store's per-account resolver: luke's live list, yoda's cached one.
    getSentMailboxPath: (id) => ((id || 'luke') === 'luke' ? '[Gmail]/Sent Mail' : 'INBOX.Sent'),
    ...over,
  });

  beforeEach(() => { pipelineManager._activeAccountId = 'luke'; });

  it('fetches that account\'s own Sent folder', async () => {
    store.state = state();
    const pipeline = livePipeline();

    await loadSent(YODA, pipeline);

    expect(pipeline.loadHeaders).toHaveBeenCalledWith('INBOX.Sent');
    expect(pipeline.loadHeaders).not.toHaveBeenCalledWith('[Gmail]/Sent Mail');
  });

  it('falls back to the folder list saved on disk when nothing is cached in memory', async () => {
    store.state = state({ getSentMailboxPath: (id) => ((id || 'luke') === 'luke' ? 'Sent' : null) });
    db.getCachedMailboxes.mockResolvedValueOnce([{ name: 'Sent Items', path: 'Sent Items', specialUse: '\\Sent' }]);
    const pipeline = livePipeline();

    await loadSent(YODA, pipeline);

    expect(db.getCachedMailboxes).toHaveBeenCalledWith('yoda');
    expect(pipeline.loadHeaders).toHaveBeenCalledWith('Sent Items');
  });

  it('puts them in the store while All inboxes is showing INBOX', async () => {
    store.state = state({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' });

    await loadSent(YODA, livePipeline());

    // The pipeline has just fetched; the store only has to read what it saved.
    expect(loadSentHeaders).toHaveBeenCalledWith('yoda', { cacheOnly: true });
  });

  it('leaves the store alone in one account\'s view and in the unified Sent view', async () => {
    store.state = state();
    await loadSent(YODA, livePipeline());
    store.state = state({ activeMailbox: 'UNIFIED', unifiedFolder: 'Sent' });
    await loadSent(YODA, livePipeline());

    expect(loadSentHeaders).not.toHaveBeenCalled();
  });

  it('still refreshes the active account\'s Sent in the store', async () => {
    store.state = state();

    await loadSent(LUKE, livePipeline());

    expect(loadSentHeaders).toHaveBeenCalledWith('luke');
  });

  // First launch: a background account has no folder list in memory or on
  // disk until the pipeline saves one, a step AFTER its Sent load. Reading at
  // its own path found nothing there, so its Sent waited for the next launch.
  it('retries a background account\'s Sent once its folder list is saved', async () => {
    store.state = state({ getSentMailboxPath: (id) => ((id || 'luke') === 'luke' ? '[Gmail]/Sent Mail' : null) });
    const yodaBoxes = [{ name: 'INBOX', path: 'INBOX' }, { name: 'Sent', path: 'INBOX.Sent', specialUse: '\\Sent' }];
    db.getCachedMailboxes.mockResolvedValueOnce(null).mockResolvedValueOnce(yodaBoxes);
    api.fetchMailboxes.mockResolvedValueOnce(yodaBoxes);
    // The real fan-out, not the stubs the top-level beforeEach installs.
    delete pipelineManager._loadSentHeaders;
    pipelineManager._destroyed = false;
    pipelineManager._backgroundHeadersRunning = false;

    await Object.getPrototypeOf(pipelineManager)._startBackgroundHeadersOnly.call(pipelineManager);

    expect(db.saveMailboxes).toHaveBeenCalledWith('yoda', yodaBoxes);
    expect(loadHeaders).toHaveBeenCalledWith('INBOX.Sent');
    expect(loadHeaders).not.toHaveBeenCalledWith('[Gmail]/Sent Mail');
  });

  it('re-reads the store when that account\'s Sent sync lands in All inboxes', async () => {
    store.state = state({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' });

    await pipelineManager._onHeadersRefreshed(YODA, livePipeline(), 'INBOX.Sent', []);

    expect(loadSentHeaders).toHaveBeenCalledWith('yoda', { cacheOnly: true });
  });
});
