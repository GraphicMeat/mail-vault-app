/**
 * An account whose backup stopped at the daily download limit is held until
 * the next UTC day. Turning the cap off, or changing the download limit, in
 * Settings releases that hold now, and a scheduled account runs again at once
 * (the same Premium, visible and scheduled gates as the midnight re-queue).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../api', () => ({
  backupRunAccount: vi.fn(),
  backupCancel: vi.fn().mockResolvedValue(undefined),
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../authUtils', () => ({
  ensureFreshToken: vi.fn(account => Promise.resolve(account)),
  hasValidCredentials: vi.fn(() => true),
  resolveServerAccount: vi.fn((id, account) => Promise.resolve({ ok: true, account })),
  resolveBackupAccount: vi.fn((id, account) => Promise.resolve({ ok: true, account })),
}));

const h = vi.hoisted(() => ({
  premium: false,
  listeners: new Set(),
  settings: {
    backupGlobalEnabled: false,
    backupGlobalConfig: { interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 },
    backupSchedules: {},
    hiddenAccounts: {},
    backupState: {},
    transferLimits: {},
  },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => h.settings,
    subscribe: (listener) => { h.listeners.add(listener); return () => h.listeners.delete(listener); },
  },
  hasPremiumAccess: () => h.premium,
}));

vi.mock('../../stores/backupStore', () => ({
  useBackupStore: { getState: () => ({ setQueue: vi.fn(), setActiveBackup: vi.fn(), clearActiveBackup: vi.fn() }) },
}));

vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ accounts: [{ id: 'acc-1', email: 'account-1@test.com', password: 'pass1' }], loading: false }),
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));

vi.mock('../snapshotService', () => ({
  createSnapshotFromMaildir: vi.fn().mockResolvedValue({}),
}));

const { backupScheduler } = await import('../backupScheduler');

const HOUR = 3600_000;
const CAP_ON = { capEnabled: true, warnEnabled: true, dailyDownLimitBytes: 100 };

/** Change the settings the way the store does: a new transferLimits object, every listener told. */
function setLimits(next) {
  const prev = h.settings;
  h.settings = { ...prev, transferLimits: next };
  for (const listener of [...h.listeners]) listener(h.settings, prev);
}

describe('backupScheduler.watchTransferLimits', () => {
  let stop;
  let queued;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2030-01-05T20:00:00Z'));
    h.listeners.clear();
    h.premium = true;
    h.settings = { ...h.settings, backupSchedules: { 'acc-1': { enabled: true, interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 } }, hiddenAccounts: {}, transferLimits: { 'acc-1': CAP_ON } };
    // The queue itself is covered by the coordinator's own suite: here only "was it queued".
    queued = vi.spyOn(backupScheduler, 'queueBackup').mockImplementation(() => {});
    backupScheduler._holdForLimit('acc-1', Date.now() + 4 * HOUR);
    stop = backupScheduler.watchTransferLimits();
  });
  afterEach(() => {
    stop?.();
    backupScheduler.stopAll();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('releases the hold and runs a scheduled account at once when the cap is switched off', () => {
    setLimits({ 'acc-1': { ...CAP_ON, capEnabled: false } });
    expect(backupScheduler._limitHolds.size).toBe(0);
    expect(queued).toHaveBeenCalledWith('acc-1');
  });

  it('does the same when the download limit is raised', () => {
    setLimits({ 'acc-1': { ...CAP_ON, dailyDownLimitBytes: 500 } });
    expect(backupScheduler._limitHolds.size).toBe(0);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('releases but does not run an account the schedule would not run (no Premium)', () => {
    h.premium = false;
    setLimits({ 'acc-1': { ...CAP_ON, capEnabled: false } });
    expect(backupScheduler._limitHolds.size).toBe(0);
    expect(queued).not.toHaveBeenCalled();
  });

  it('releases but does not run an account with no schedule', () => {
    h.settings = { ...h.settings, backupSchedules: {} };
    setLimits({ 'acc-1': { ...CAP_ON, capEnabled: false } });
    expect(backupScheduler._limitHolds.size).toBe(0);
    expect(queued).not.toHaveBeenCalled();
  });

  it('keeps the hold for a change to the warning or the upload limit, or to another account', () => {
    setLimits({ 'acc-1': { ...CAP_ON, warnEnabled: false, dailyUpLimitBytes: 9 }, 'acc-2': { capEnabled: false } });
    expect(backupScheduler._limitHolds.size).toBe(1);
    expect(queued).not.toHaveBeenCalled();
  });

  it('stops listening once the returned function is called, and the hold then runs out as before', () => {
    stop();
    stop = null;
    expect(h.listeners.size).toBe(0);
    setLimits({ 'acc-1': { ...CAP_ON, capEnabled: false } });
    expect(backupScheduler._limitHolds.size).toBe(1);
    expect(queued).not.toHaveBeenCalled();
  });
});
