/**
 * The app's body pipeline downloads ahead only what the account's download
 * mode keeps (Track H): On Demand nothing, Keep Recent the window (as
 * before), Hoarder everything. Same rule as the daemon's gates
 * (`src/utils/fetchPolicy.js`, a port of `src-core/src/fetch_mode.rs`).
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
const policy = (mode, windowMonths = 3) => ({ mode, windowMonths, hoarderPremium: false });

describe('_getUncachedUids by download mode', () => {
  it('On Demand downloads nothing ahead', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, policy('onDemand'), NOW)).toEqual([]);
  });

  it('a hidden account (no policy) downloads nothing ahead', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, null, NOW)).toEqual([]);
  });

  it('Keep Recent is unchanged: unsaved mail inside the window, undated mail left out', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, policy('keepRecent'), NOW)).toEqual([1]);
  });

  it('Index Only downloads what Keep Recent would', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, policy('indexOnly'), NOW)).toEqual([1]);
  });

  it('Hoarder (and the legacy window 0) downloads every unsaved message', () => {
    expect(pipelineManager._getUncachedUids(rows, saved, policy('hoarder'), NOW)).toEqual([1, 2, 4]);
    expect(pipelineManager._getUncachedUids(rows, saved, policy('keepRecent', 0), NOW)).toEqual([1, 2, 4]);
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
    store.state = {
      accounts: [{ id: 'luke', email: 'luke@x' }],
      activeMailbox: 'INBOX',
      emails: [{ uid: 11, date: new Date().toISOString() }],
      savedEmailIds: new Set(),
    };
  });

  it('On Demand hands the pipeline an empty list (the attachment step still runs)', async () => {
    store.settings = { hiddenAccounts: {}, cacheLimitMB: 128, fetchMode: 'onDemand', localCacheDurationMonths: 3 };
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([], 'INBOX');
  });

  // Index Only evicts every copy whose body the search index holds; counting
  // only the vault would download them again at every launch (review I2).
  it('Index Only counts a body the search index holds as kept', async () => {
    bodyIndexed.uids = new Set([11]);
    store.settings = { hiddenAccounts: {}, cacheLimitMB: 128, fetchMode: 'indexOnly', localCacheDurationMonths: 3 };
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([], 'INBOX');
  });

  it('Index Only downloads the body when the index cannot say (null)', async () => {
    bodyIndexed.uids = null;
    store.settings = { hiddenAccounts: {}, cacheLimitMB: 128, fetchMode: 'indexOnly', localCacheDurationMonths: 3 };
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([11], 'INBOX');
  });

  it('Keep Recent never treats an indexed body as kept', async () => {
    bodyIndexed.uids = new Set([11]);
    store.settings = { hiddenAccounts: {}, cacheLimitMB: 128, fetchMode: 'keepRecent', localCacheDurationMonths: 3 };
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([11], 'INBOX');
  });

  it('a per-account override wins over the global mode', async () => {
    store.settings = { hiddenAccounts: {}, cacheLimitMB: 128, fetchMode: 'onDemand', fetchModes: { luke: 'keepRecent' }, localCacheDurationMonths: 3 };
    await pipelineManager.startActiveAccountPipeline('luke');
    expect(startContentCaching).toHaveBeenCalledWith([11], 'INBOX');
  });
});
