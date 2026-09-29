/**
 * Turning the daily-limit cap off, or changing the download limit, in Settings
 * wakes a download-ahead pass that sleeps at the limit now, not at the next
 * UTC day. Only the cap and the download limit count: the warning and the
 * upload limit change nothing about what the daemon lets through today.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../AccountPipeline', () => ({
  AccountPipeline: class {
    constructor() {
      this._destroyed = false;
      this._activeSlots = 0;
    }
    destroy() { this._destroyed = true; }
  },
}));

vi.mock('../authUtils', () => ({ hasValidCredentials: () => true, ensureFreshToken: (a) => Promise.resolve(a) }));

vi.mock('../api', () => ({ fetchMailboxes: vi.fn().mockResolvedValue([]) }));

const store = vi.hoisted(() => ({ state: {}, settings: { transferLimits: {} }, listeners: new Set() }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => store.state, setState: vi.fn(), subscribe: () => () => {} },
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => store.settings,
    subscribe: (listener) => { store.listeners.add(listener); return () => store.listeners.delete(listener); },
  },
}));

vi.mock('../db', () => ({
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getBodyIndexedUids: vi.fn(async () => null),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getCachedMailboxes: vi.fn().mockResolvedValue(null),
}));

vi.mock('../graphConfig', () => ({
  isGraphAccount: () => false,
  graphFoldersToMailboxes: () => [],
}));

const { pipelineManager } = await import('../EmailPipelineManager');

/** Change the settings the way the store does: a new transferLimits object, every listener told. */
function setLimits(next) {
  const prev = store.settings;
  store.settings = { ...prev, transferLimits: next };
  for (const listener of [...store.listeners]) listener(store.settings, prev);
}

const sleeper = () => ({ _destroyed: false, wakeFromLimit: vi.fn() });

describe('pipelineManager.watchTransferLimits', () => {
  let stop;
  beforeEach(() => {
    store.listeners.clear();
    store.settings = { transferLimits: { 'acc-1': { capEnabled: true, warnEnabled: true, dailyDownLimitBytes: 100 } } };
    pipelineManager.pipelines.clear();
    stop = pipelineManager.watchTransferLimits();
  });
  afterEach(() => {
    stop?.();
    pipelineManager.pipelines.clear();
  });

  it('wakes the account\'s pipeline when its cap is switched off', () => {
    const mine = sleeper();
    const other = sleeper();
    pipelineManager.pipelines.set('acc-1', mine);
    pipelineManager.pipelines.set('acc-2', other);

    setLimits({ 'acc-1': { capEnabled: false, warnEnabled: true, dailyDownLimitBytes: 100 } });

    expect(mine.wakeFromLimit).toHaveBeenCalledTimes(1);
    expect(other.wakeFromLimit).not.toHaveBeenCalled();
  });

  it('wakes it when the download limit changes', () => {
    const mine = sleeper();
    pipelineManager.pipelines.set('acc-1', mine);
    setLimits({ 'acc-1': { capEnabled: true, warnEnabled: true, dailyDownLimitBytes: 500 } });
    expect(mine.wakeFromLimit).toHaveBeenCalledTimes(1);
  });

  it('leaves it asleep for a change to the warning or the upload limit, or to another setting', () => {
    const mine = sleeper();
    pipelineManager.pipelines.set('acc-1', mine);
    setLimits({ 'acc-1': { capEnabled: true, warnEnabled: false, dailyDownLimitBytes: 100, dailyUpLimitBytes: 9 } });
    const prev = store.settings;
    store.settings = { ...prev, theme: 'dark' };
    for (const listener of [...store.listeners]) listener(store.settings, prev);
    expect(mine.wakeFromLimit).not.toHaveBeenCalled();
  });

  it('stops listening once the returned function is called', () => {
    const mine = sleeper();
    pipelineManager.pipelines.set('acc-1', mine);
    stop();
    stop = null;
    expect(store.listeners.size).toBe(0);
    setLimits({ 'acc-1': { capEnabled: false } });
    expect(mine.wakeFromLimit).not.toHaveBeenCalled();
  });
});
