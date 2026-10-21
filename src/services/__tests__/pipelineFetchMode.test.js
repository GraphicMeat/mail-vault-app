/**
 * The app's body pipeline downloads ahead only what the account's download
 * mode keeps (Track H): On Demand nothing, Keep Recent the window (as
 * before), Hoarder everything. The daemon decides (`policy.accounts`, its
 * `fetch.keep` answer from src-core/src/fetch_mode.rs, pinned there by the
 * shared fixture); these specs hand the pipeline the daemon's answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startContentCaching = vi.fn(() => Promise.resolve());

vi.mock('../AccountPipeline', () => ({
  AccountPipeline: class {
    constructor() {
      this._destroyed = false;
      this._activeSlots = 0;
      this.startContentCaching = startContentCaching;
      this.resume = vi.fn();
      this.loadHeaders = vi.fn(() => Promise.resolve());
    }
    destroy() { this._destroyed = true; }
    waitForComplete() { return Promise.resolve(); }
  },
}));

vi.mock('../authUtils', () => ({ hasValidCredentials: () => true, ensureFreshToken: (a) => Promise.resolve(a) }));

vi.mock('../api', () => ({ fetchMailboxes: vi.fn().mockResolvedValue([]) }));

const store = vi.hoisted(() => ({ state: {}, settings: {} }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => store.state, setState: vi.fn(), subscribe: () => () => {} },
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => store.settings },
}));

// The daemon's `policy.accounts` answer for each account (`fetch` only).
const daemon = vi.hoisted(() => ({ fetch: {}, asked: [] }));
vi.mock('../transport', () => ({
  send: vi.fn(async (method, params) => {
    if (method !== 'policy.accounts') throw new Error(`unexpected ${method}`);
    daemon.asked.push(params);
    return { accounts: Object.fromEntries(params.accounts.map((a) => [a.id, { fetch: daemon.fetch[a.id] ?? null, transfer: {} }])) };
  }),
}));

const bodyIndexed = vi.hoisted(() => ({ uids: null }));
vi.mock('../db', () => ({
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getBodyIndexedUids: vi.fn(async () => bodyIndexed.uids),
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

const NOW = Date.UTC(2026, 8, 27, 12);
const RECENT = '2026-09-20T10:00:00Z';
const OLD = '2025-01-01T10:00:00Z';
const rows = [
  { uid: 1, date: RECENT },
  { uid: 2, date: OLD },
  { uid: 3, date: RECENT }, // already saved
  { uid: 4 }, // no date at all
];
const saved = new Set([3]);
// The daemon's `fetch` view: `keep` is what the download-ahead takes.
const CUTOFF = Date.UTC(2026, 5, 27, 12); // three months before NOW
const view = (mode, keep, keepSinceMs = null) => ({ mode, windowMonths: 3, hoarderPremium: false, keep, keepSinceMs });
const ON_DEMAND = view('onDemand', 'none');
const KEEP_RECENT = view('keepRecent', 'since', CUTOFF);
const INDEX_ONLY = view('indexOnly', 'since', CUTOFF);
const HOARDER = view('hoarder', 'all');

describe('_getUncachedUids by download mode', () => {
  it('On Demand downloads nothing ahead', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, ON_DEMAND)).toEqual([]);
  });

  it('a hidden account (no policy) downloads nothing ahead', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, null)).toEqual([]);
  });

  // Undated mail is kept, as the daemon's download gate keeps it
  // (`keeps_body_dated`); the JS port used to leave it out.
  it('Keep Recent: unsaved mail inside the window, and undated mail', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, KEEP_RECENT)).toEqual([1, 4]);
  });

  it('Index Only downloads what Keep Recent would', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, INDEX_ONLY)).toEqual([1, 4]);
  });

  it('Hoarder (and the legacy window 0, `keep: all`) downloads every unsaved message', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, HOARDER)).toEqual([1, 2, 4]);
    expect(pipelineManager._getUncachedUids(rows, saved, view('keepRecent', 'all'))).toEqual([1, 2, 4]);
  });
});

describe('the active account pipeline reads the account\'s own mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bodyIndexed.uids = null;
    pipelineManager.pipelines.clear();
    pipelineManager._activeAccountId = null;
    pipelineManager._contentCascadeDone.clear();
    pipelineManager._loadSentHeaders = vi.fn();
    pipelineManager._startBackgroundHeadersOnly = vi.fn();
    daemon.fetch = {};
    daemon.asked = [];
    store.settings = { hiddenAccounts: {}, cacheLimitMB: 128 };
    store.state = {
      accounts: [{ id: 'luke', email: 'luke@x', imapHost: 'imap.x' }],
      activeMailbox: 'INBOX',
      emails: [{ uid: 11, date: new Date().toISOString() }],
      savedEmailIds: new Set(),
    };
  });

  it('On Demand hands the pipeline an empty list (the attachment step still runs)', async () => {
    daemon.fetch.luke = ON_DEMAND;
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([], 'INBOX');
    expect(daemon.asked).toEqual([{ accounts: [{ id: 'luke', imapHost: 'imap.x' }] }]);
  });

  it('a daemon that cannot answer downloads nothing ahead', async () => {
    const { send } = await import('../transport');
    send.mockRejectedValueOnce(new Error('daemon gone'));
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([], 'INBOX');
  });

  // Index Only evicts every copy whose body the search index holds; counting
  // only the vault would download them again at every launch (review I2).
  it('Index Only counts a body the search index holds as kept', async () => {
    bodyIndexed.uids = new Set([11]);
    daemon.fetch.luke = view('indexOnly', 'all');
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([], 'INBOX');
  });

  it('Index Only downloads the body when the index cannot say (null)', async () => {
    bodyIndexed.uids = null;
    daemon.fetch.luke = view('indexOnly', 'all');
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([11], 'INBOX');
  });

  it('Keep Recent never treats an indexed body as kept', async () => {
    bodyIndexed.uids = new Set([11]);
    daemon.fetch.luke = view('keepRecent', 'all');
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([11], 'INBOX');
  });

  it('fetches what the daemon says this account keeps', async () => {
    daemon.fetch.luke = KEEP_RECENT;
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([11], 'INBOX');
  });
});
