import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────

// Tauri event bus — capture the handlers so specs can fire progress events.
const mockEventHandlers = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => { mockEventHandlers[name] = cb; return () => {}; }),
}));

// Mock api — all calls are no-ops by default
vi.mock('../../src/services/api', () => ({
  backupRunAccount: vi.fn().mockResolvedValue({ emails_backed_up: 5, duration_secs: 2, success: true }),
  backupCancel: vi.fn().mockResolvedValue(undefined),
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

// Mock authUtils
vi.mock('../../src/services/authUtils', () => ({
  ensureFreshToken: vi.fn(account => Promise.resolve(account)),
  hasValidCredentials: vi.fn(() => true),
  resolveServerAccount: vi.fn((id, account) => Promise.resolve({ ok: true, account })),
  resolveBackupAccount: vi.fn((id, account) => Promise.resolve({ ok: true, account })),
}));

// Mock settingsStore
const mockSettingsState = {
  backupGlobalEnabled: false,
  backupGlobalConfig: { interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 },
  backupSchedules: {},
  hiddenAccounts: {},
  backupState: {},
  backupCustomPath: null,
  backupNotifyOnSuccess: false,
  backupNotifyOnFailure: false,
  updateBackupState: vi.fn(),
  addBackupHistoryEntry: vi.fn(),
  // Share-to-unlock: hasPremiumAccess is mocked false below, so a successful
  // backup always reaches this branch.
  shareGrant: null,
  shareUnlockLastShownAt: 0,
  markShareUnlockShown: vi.fn(),
};
// Default false: the upsell / share-unlock branches under _runBackup need a
// free user. Automatic-scheduling tests flip it on, because checkAndQueueDue
// refuses to queue anything without premium.
let mockPremium = false;
vi.mock('../../src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => mockSettingsState },
  hasPremiumAccess: () => mockPremium,
}));

// Mock backupStore
const mockBackupState = { activeBackup: null, queue: [] };
// Persistent across getState() calls: the queue-publishing specs assert on the
// arguments of every call, which a per-call vi.fn() would throw away.
const mockSetQueue = vi.fn((ids) => { mockBackupState.queue = ids; });
vi.mock('../../src/stores/backupStore', () => ({
  useBackupStore: {
    getState: () => ({
      ...mockBackupState,
      setActiveBackup: vi.fn((v) => { mockBackupState.activeBackup = v; }),
      clearActiveBackup: vi.fn(() => { mockBackupState.activeBackup = null; }),
      setShareUnlock: vi.fn(),
      setQueue: mockSetQueue,
    }),
  },
}));

// Mock mailStore
const mockAccounts = [
  { id: 'acc-1', email: 'luke@test.com', password: 'pass1' },
  { id: 'acc-2', email: 'vader@test.com', password: 'pass2' },
];
vi.mock('../../src/stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ accounts: mockAccounts, loading: false }),
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));

// Mock snapshotService (imported by backupScheduler for post-backup snapshots)
vi.mock('../../src/services/snapshotService', () => ({
  createSnapshotFromMaildir: vi.fn().mockResolvedValue({}),
}));

// ── Import after mocks ────────────────────────────────────────────────────

// Destructured off a dynamic import on purpose: a named static import of an
// export the module does not have yet is a link error that kills every test in
// the file, which is not the RED we want to read.
const { backupScheduler, State, computeNextEligibleTime, BACKUP_STALL_MS } = await import(
  '../../src/services/backupScheduler'
);
const api = await import('../../src/services/api');
const { t } = await import('../../src/i18n/index.js');

beforeAll(async () => {
  await backupScheduler.initProgressListener();
});

// ── Helpers ──────────────────────────────────────────────────────────────

function resetCoordinator() {
  backupScheduler.stopAll();
  backupScheduler._state = State.IDLE;
  backupScheduler._running = new Map();
  backupScheduler._retryCount = new Map();
  backupScheduler._queue = [];
  backupScheduler._queueRunning = false;
  backupScheduler._pausedAccountId = null;
  backupScheduler._manualIds = new Set();
  backupScheduler._manualResolvers = new Map();
  backupScheduler._checkpoints = new Map();
  backupScheduler._stalled = new Set();
  backupScheduler._lastProgressAt = Date.now();
  mockBackupState.activeBackup = null;
  mockBackupState.queue = [];
  mockPremium = false;
  vi.clearAllMocks();
  // clearAllMocks leaves a queued `...Once` implementation in place. A spec
  // whose retry never fires (exactly what the RED run looks like) would hand
  // its leftover to the next spec, which then fails for someone else's reason.
  api.backupRunAccount.mockReset();
  api.backupRunAccount.mockResolvedValue({ emails_backed_up: 5, duration_secs: 2, success: true });
}

/** A `backup-progress` payload in the shape Rust emits. */
const progressPayload = (over = {}) => ({
  account_id: 'acc-1',
  folder: 'INBOX',
  total_folders: 9,
  completed_folders: 1,
  total_emails: 0,
  completed_emails: 100,
  errors: 0,
  active: true,
  ...over,
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('BackupCoordinator — lifecycle state', () => {
  beforeEach(resetCoordinator);

  it('starts in idle state', () => {
    expect(backupScheduler.state).toBe(State.IDLE);
  });

  it('transitions to paused_sleep on onSleep', () => {
    backupScheduler.onSleep();
    expect(backupScheduler.state).toBe(State.PAUSED_SLEEP);
  });

  it('transitions to paused_offline on onOffline', () => {
    backupScheduler.onOffline();
    expect(backupScheduler.state).toBe(State.PAUSED_OFFLINE);
  });

  it('resumes from paused_sleep on onWake', () => {
    backupScheduler.onSleep();
    backupScheduler.onWake();
    expect(backupScheduler.state).toBe(State.IDLE);
  });

  it('resumes from paused_offline on onOnline', () => {
    backupScheduler.onOffline();
    backupScheduler.onOnline();
    expect(backupScheduler.state).toBe(State.IDLE);
  });

  it('onWake is a no-op when not paused_sleep', () => {
    backupScheduler._state = State.PAUSED_OFFLINE;
    backupScheduler.onWake();
    expect(backupScheduler.state).toBe(State.PAUSED_OFFLINE);
  });

  it('onOnline is a no-op when not paused_offline', () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler.onOnline();
    expect(backupScheduler.state).toBe(State.PAUSED_SLEEP);
  });
});

describe('BackupCoordinator — queue behavior', () => {
  beforeEach(resetCoordinator);

  it('does not double-queue the same account', () => {
    backupScheduler._state = State.PAUSED_SLEEP; // prevent processing
    backupScheduler.queueBackup('acc-1');
    backupScheduler.queueBackup('acc-1');
    expect(backupScheduler._queue).toEqual(['acc-1']);
  });

  it('does not queue an account that is already running', () => {
    backupScheduler._running.set('acc-1', true);
    backupScheduler.queueBackup('acc-1');
    expect(backupScheduler._queue).toEqual([]);
  });

  it('queues multiple different accounts', () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler.queueBackup('acc-1');
    backupScheduler.queueBackup('acc-2');
    expect(backupScheduler._queue).toEqual(['acc-1', 'acc-2']);
  });

  it('stopAll clears queue and calls backupCancel', () => {
    backupScheduler._running.set('acc-1', true);
    backupScheduler._queue = ['acc-2'];
    backupScheduler.stopAll();
    expect(backupScheduler._queue).toEqual([]);
    expect(api.backupCancel).toHaveBeenCalled();
  });
});

describe('BackupCoordinator — gate enforcement', () => {
  beforeEach(resetCoordinator);

  it('does not process queue when paused (automatic backup)', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler.queueBackup('acc-1');
    // Give time for async processing
    await new Promise(r => setTimeout(r, 50));
    expect(api.backupRunAccount).not.toHaveBeenCalled();
    expect(backupScheduler._queue).toEqual(['acc-1']);
  });

  it('processes manual backups even when paused', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler.triggerManualBackup('acc-1');
    await new Promise(r => setTimeout(r, 50));
    expect(api.backupRunAccount).toHaveBeenCalled();
  });

  it('checkAndQueueDue skips when mail is loading', async () => {
    const mailMod = await import('../../src/stores/mailStore');
    const orig = mailMod.useMailStore.getState;
    mailMod.useMailStore.getState = () => ({ accounts: mockAccounts, loading: true });
    mockPremium = true;
    mockSettingsState.backupGlobalEnabled = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toEqual([]);
    mailMod.useMailStore.getState = orig;
    mockSettingsState.backupGlobalEnabled = false;
  });

  it('checkAndQueueDue skips when paused', () => {
    backupScheduler._state = State.PAUSED_OFFLINE;
    mockPremium = true;
    mockSettingsState.backupGlobalEnabled = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toEqual([]);
    mockSettingsState.backupGlobalEnabled = false;
  });
});

describe('BackupCoordinator — pause cancels active Rust backup', () => {
  beforeEach(resetCoordinator);

  it('onSleep calls backupCancel when work is active', () => {
    backupScheduler._running.set('acc-1', true);
    backupScheduler.onSleep();
    expect(api.backupCancel).toHaveBeenCalled();
    expect(backupScheduler._pausedAccountId).toBe('acc-1');
  });

  it('onOffline calls backupCancel when work is active', () => {
    backupScheduler._running.set('acc-1', true);
    backupScheduler.onOffline();
    expect(api.backupCancel).toHaveBeenCalled();
  });

  // Front of the queue is only observable in the run order now: resume drives
  // the queue instead of parking work in it, so by the time the caller looks
  // the interrupted account has already been shifted off and started.
  it('resume runs the interrupted account before the rest of the queue', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._pausedAccountId = 'acc-1';
    backupScheduler._queue = ['acc-2'];
    backupScheduler.onWake();
    await new Promise(r => setTimeout(r, 50));
    expect(api.backupRunAccount.mock.calls.map(c => c[0])).toEqual(['acc-1', 'acc-2']);
  });
});

describe('BackupCoordinator — manual backup while paused preserves pause state', () => {
  beforeEach(resetCoordinator);

  it('running a manual backup while paused_offline restores paused_offline afterward', async () => {
    backupScheduler._state = State.PAUSED_OFFLINE;
    backupScheduler.triggerManualBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    // After manual backup completes, state should be restored to paused_offline
    expect(backupScheduler.state).toBe(State.PAUSED_OFFLINE);
  });

  it('running a manual backup while paused_sleep restores paused_sleep afterward', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler.triggerManualBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(backupScheduler.state).toBe(State.PAUSED_SLEEP);
  });

  it('automatic items behind manual in queue stay blocked after manual completes', async () => {
    backupScheduler._state = State.PAUSED_OFFLINE;
    backupScheduler._queueRunning = true;
    backupScheduler._manualIds.add('acc-1');
    backupScheduler._queue = ['acc-1', 'acc-2']; // manual first, automatic second
    backupScheduler._queueRunning = false;

    await backupScheduler._processQueue();
    await new Promise(r => setTimeout(r, 50));

    // Manual acc-1 should have run
    expect(api.backupRunAccount).toHaveBeenCalledTimes(1);
    expect(api.backupRunAccount).toHaveBeenCalledWith('acc-1', expect.any(String), null, 0);
    // Automatic acc-2 should still be queued (not executed)
    expect(backupScheduler._queue).toContain('acc-2');
    // State should still be paused
    expect(backupScheduler.state).toBe(State.PAUSED_OFFLINE);
  });
});

// ── A manual backup is the user watching a button: it runs, now, first ─────
//
// 2026-09-12: 13 automatic ids sat in the queue while the user clicked
// "Back up now" and "Back up all accounts now" for three hours and nothing
// ran. The click went through `queueBackup`, which returns early for an id
// already queued, and landed behind automatic work the pause gate refused to
// start. The specs below drive the queue from the BACK, which is where the
// old ones never looked.

describe('BackupCoordinator - a manual backup jumps the queue', () => {
  beforeEach(resetCoordinator);

  it('runs and resolves while paused with automatic work queued ahead of it', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._queue = ['acc-2'];

    let resolved = null;
    backupScheduler.triggerManualBackup('acc-1').then(r => { resolved = r; });
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).toHaveBeenCalledTimes(1);
    expect(api.backupRunAccount.mock.calls[0][0]).toBe('acc-1');
    expect(resolved).toMatchObject({ status: 'success' });
    expect(backupScheduler._queue).toEqual(['acc-2']);
    expect(backupScheduler.state).toBe(State.PAUSED_SLEEP);
  });

  it('runs an account that is already queued automatically', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._queue = ['acc-1'];

    let resolved = null;
    backupScheduler.triggerManualBackup('acc-1').then(r => { resolved = r; });
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).toHaveBeenCalledTimes(1);
    expect(api.backupRunAccount.mock.calls[0][0]).toBe('acc-1');
    expect(resolved).toMatchObject({ status: 'success' });
    expect(backupScheduler._queue).toEqual([]);
  });

  it('runs before automatic work that was queued first', async () => {
    backupScheduler._queue = ['acc-2'];
    backupScheduler._queueRunning = false;

    backupScheduler.triggerManualBackup('acc-1');
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount.mock.calls.map(c => c[0])).toEqual(['acc-1', 'acc-2']);
  });

  it('tick drives a paused queue that holds a manual id', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._queue = ['acc-1'];
    backupScheduler._manualIds.add('acc-1');

    backupScheduler.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).toHaveBeenCalledWith('acc-1', expect.any(String), null, 0);
  });

  it('tick leaves a paused queue of automatic ids alone', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._queue = ['acc-1'];

    backupScheduler.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).not.toHaveBeenCalled();
  });

  it('publishes the queue to the store on every mutation', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;

    backupScheduler.queueBackup('acc-2');
    backupScheduler.triggerManualBackup('acc-1');
    await new Promise(r => setTimeout(r, 50));
    backupScheduler.stopAll();

    expect(mockSetQueue.mock.calls.map(c => c[0])).toEqual([
      ['acc-2'],           // queueBackup push
      ['acc-1', 'acc-2'],  // manual unshift, to the front
      ['acc-2'],           // taken off by the queue loop
      [],                  // stopAll clear
    ]);
  });
});

describe('BackupCoordinator — backup execution', () => {
  beforeEach(resetCoordinator);

  it('runs backup and updates state on success', async () => {
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));
    expect(api.backupRunAccount).toHaveBeenCalledWith(
      'acc-1',
      expect.any(String),
      null,
      0
    );
    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastStatus: 'success',
    }));
    expect(mockSettingsState.addBackupHistoryEntry).toHaveBeenCalled();
  });

  it('marks manual flag in activeBackup', async () => {
    backupScheduler.triggerManualBackup('acc-1');
    await new Promise(r => setTimeout(r, 10));
    // The first setActiveBackup call should have manual: true
    expect(mockBackupState.activeBackup).toMatchObject({ manual: true });
  });

  it('saves checkpoint on cancelled result and resumes with skipFolders', async () => {
    // First run returns cancelled at folder 3
    api.backupRunAccount.mockResolvedValueOnce({
      emails_backed_up: 2,
      duration_secs: 1,
      success: false,
      cancelled: true,
      completed_folders: 3,
    });
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    // Checkpoint should be saved
    expect(backupScheduler._checkpoints.get('acc-1')).toBe(3);
    // Should NOT have recorded a history entry (cancelled, not completed)
    expect(mockSettingsState.addBackupHistoryEntry).not.toHaveBeenCalled();

    // Second run should pass skipFolders=3
    api.backupRunAccount.mockResolvedValueOnce({
      emails_backed_up: 5,
      duration_secs: 2,
      success: true,
      cancelled: false,
      completed_folders: 10,
    });
    backupScheduler._running.set('acc-1', false);
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(api.backupRunAccount).toHaveBeenLastCalledWith(
      'acc-1',
      expect.any(String),
      null,
      3 // skipFolders from checkpoint
    );
    // Checkpoint should be cleared after successful completion
    expect(backupScheduler._checkpoints.has('acc-1')).toBe(false);
  });

  it('skips accounts with no valid credentials', async () => {
    const authUtils = await import('../../src/services/authUtils');
    authUtils.resolveServerAccount.mockResolvedValueOnce({ ok: false, reason: 'missing_credentials', message: 'Missing credentials' });
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 50));
    expect(api.backupRunAccount).not.toHaveBeenCalled();
    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastStatus: 'failed',
    }));
  });
});

/**
 * 2026-08-27: a run that saved 788 of 789 messages notified
 * "Backup failed - Unknown error. Will retry on next idle." The one refused
 * message flipped the whole run to failed, and the backend sent no error text
 * to put in its place. Both halves are asserted here.
 */
describe('BackupCoordinator — a run that lost some messages', () => {
  beforeEach(resetCoordinator);

  const partialResult = {
    emails_backed_up: 788,
    errors: 1,
    duration_secs: 389,
    success: true,
    error_message: '1 of 789 messages could not be fetched. Last error: IMAP fetch failed: UID FETCH 799 failed',
  };

  it('records degraded, not failed', async () => {
    api.backupRunAccount.mockResolvedValueOnce(partialResult);
    mockSettingsState.backupNotifyOnFailure = true;
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastStatus: 'degraded',
      lastError: partialResult.error_message,
    }));
  });

  it('notifies "partially complete" and never says "Unknown error"', async () => {
    api.backupRunAccount.mockResolvedValueOnce(partialResult);
    mockSettingsState.backupNotifyOnFailure = true;
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(api.sendNotification).toHaveBeenCalledTimes(1);
    const [title, body] = api.sendNotification.mock.calls[0];
    expect(title).toContain('Backup partially complete');
    expect(title).not.toContain('failed');
    expect(body).toContain('788 emails backed up');
    expect(body).toContain('UID FETCH 799 failed');
    expect(body).not.toContain('Unknown error');
  });

  it('keeps the history entry honest — success with a count of what was lost', async () => {
    api.backupRunAccount.mockResolvedValueOnce(partialResult);
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(mockSettingsState.addBackupHistoryEntry).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      success: true,
      errors: 1,
      emailsBackedUp: 788,
      error: partialResult.error_message,
    }));
  });

  it('resolves a manual run as degraded so the button does not claim failure', async () => {
    api.backupRunAccount.mockResolvedValueOnce(partialResult);
    const result = await backupScheduler.triggerManualBackup('acc-1');
    expect(result.status).toBe('degraded');
    expect(result.message).toBe(partialResult.error_message);
  });

  it('still reports a run with no errors as plain success', async () => {
    api.backupRunAccount.mockResolvedValueOnce({
      emails_backed_up: 5, errors: 0, duration_secs: 2, success: true,
    });
    mockSettingsState.backupNotifyOnSuccess = true;
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastStatus: 'success',
    }));
    expect(api.sendNotification.mock.calls[0][0]).toContain('Backup complete');
    mockSettingsState.backupNotifyOnSuccess = false;
  });

  it('an external-copy failure alone still reads as partial', async () => {
    api.backupRunAccount.mockResolvedValueOnce({
      emails_backed_up: 12, errors: 0, duration_secs: 3, success: true,
      external_copy_ok: false, external_copy_failed_count: 2,
      external_copy_error: '2 emails failed to copy to external backup',
    });
    mockSettingsState.backupNotifyOnFailure = true;
    backupScheduler.queueBackup('acc-1');
    await new Promise(r => setTimeout(r, 100));

    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastStatus: 'degraded',
    }));
    const [title, body] = api.sendNotification.mock.calls[0];
    expect(title).toContain('Backup partially complete');
    expect(body).toContain('external backup');
  });

  afterEach(() => {
    mockSettingsState.backupNotifyOnFailure = false;
  });
});

describe('BackupCoordinator — manual backup result contract', () => {
  beforeEach(resetCoordinator);

  it('triggerManualBackup resolves with success after real backup completes', async () => {
    const resultPromise = backupScheduler.triggerManualBackup('acc-1');
    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  it('triggerManualBackup resolves with failed_credentials when credentials are unavailable', async () => {
    const authUtils = await import('../../src/services/authUtils');
    authUtils.resolveServerAccount.mockResolvedValueOnce({
      ok: false,
      reason: 'missing_credentials',
      message: 'Credentials unavailable — retry keychain access or re-enter in Settings > Accounts',
    });
    const result = await backupScheduler.triggerManualBackup('acc-1');
    expect(result.status).toBe('failed_credentials');
    expect(result.message).toBe('Credentials unavailable — retry keychain access or re-enter in Settings > Accounts');
  });

  it('triggerManualBackup resolves with failed immediately on error (no retries)', async () => {
    api.backupRunAccount.mockRejectedValueOnce(new Error('IMAP connection failed'));
    const result = await backupScheduler.triggerManualBackup('acc-1');
    expect(result.status).toBe('failed');
    expect(result.message).toContain('IMAP connection failed');
    // Manual backups should NOT retry — resolve immediately so the button updates
    expect(api.backupRunAccount).toHaveBeenCalledTimes(1);
  });

  it('credential failure records history entry and does not show Complete in active backup', async () => {
    const authUtils = await import('../../src/services/authUtils');
    authUtils.resolveServerAccount.mockResolvedValueOnce({ ok: false, reason: 'missing_credentials', message: 'Missing credentials' });
    await backupScheduler.triggerManualBackup('acc-1');
    // Should have recorded a failed history entry
    expect(mockSettingsState.addBackupHistoryEntry).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      success: false,
      error: 'Missing credentials',
    }));
    // activeBackup should be cleared (not showing "Complete")
    expect(mockBackupState.activeBackup).toBeNull();
  });
});

// ── computeNextEligibleTime ─────────────────────────────────────────

describe('computeNextEligibleTime', () => {
  it('returns 0 for never-backed-up accounts', () => {
    expect(computeNextEligibleTime(null, { interval: 'daily' })).toBe(0);
    expect(computeNextEligibleTime({ lastBackupTime: 0 }, { interval: 'daily' })).toBe(0);
  });

  it('returns lastBackup + interval for hourly', () => {
    const last = Date.now() - 2 * 3600_000; // 2h ago
    const result = computeNextEligibleTime(
      { lastBackupTime: last },
      { interval: 'hourly', hourlyInterval: 1 }
    );
    // Should be last + 1h, but at least last + MIN_BACKUP_INTERVAL (1h)
    expect(result).toBe(last + 3600_000);
  });

  it('respects hourlyInterval multiplier', () => {
    const last = Date.now() - 5 * 3600_000; // 5h ago
    const result = computeNextEligibleTime(
      { lastBackupTime: last },
      { interval: 'hourly', hourlyInterval: 4 }
    );
    expect(result).toBe(last + 4 * 3600_000);
  });

  it('aligns daily backups to timeOfDay', () => {
    // Last backup at 2026-03-20 15:00
    const last = new Date('2026-03-20T15:00:00').getTime();
    const result = computeNextEligibleTime(
      { lastBackupTime: last },
      { interval: 'daily', timeOfDay: '03:00' }
    );
    const resultDate = new Date(result);
    expect(resultDate.getHours()).toBe(3);
    expect(resultDate.getMinutes()).toBe(0);
    // Should be 2026-03-21 03:00 (next day since 03:00 on 3/21 is after last+24h)
    expect(resultDate.getDate()).toBeGreaterThanOrEqual(21);
  });

  it('aligns weekly backups to dayOfWeek and timeOfDay', () => {
    // Last backup on a Monday (2026-03-16 is a Monday)
    const last = new Date('2026-03-16T10:00:00').getTime();
    const result = computeNextEligibleTime(
      { lastBackupTime: last },
      { interval: 'weekly', timeOfDay: '02:00', dayOfWeek: 1 } // Monday
    );
    const resultDate = new Date(result);
    expect(resultDate.getDay()).toBe(1); // Monday
    expect(resultDate.getHours()).toBe(2);
    expect(resultDate.getMinutes()).toBe(0);
    // base = last + 7 days = 2026-03-23T10:00. Aligned to 02:00 → 2026-03-24T02:00.
    // Then advance to Monday → 2026-03-30T02:00.
    expect(resultDate.getDate()).toBe(30);
  });

  it('enforces minimum 1-hour interval', () => {
    const last = Date.now() - 30 * 60_000; // 30 min ago
    const result = computeNextEligibleTime(
      { lastBackupTime: last },
      { interval: 'hourly', hourlyInterval: 1 }
    );
    // Should be at least last + 1h (MIN_BACKUP_INTERVAL)
    expect(result).toBeGreaterThanOrEqual(last + 3600_000);
  });
});

describe('computeNextEligibleTime — hours mode', () => {
  // "At set hours": run on the top of a selected hour, never inside the hour
  // that already holds a backup. Fixed local-time `now` values, so a machine
  // in any zone reads the same wall clock the user picked.
  const at = (h, m = 0, s = 0, day = 20) => new Date(2026, 2, day, h, m, s, 0).getTime();

  it('picks the next selected hour today when never backed up', () => {
    expect(computeNextEligibleTime(null, { interval: 'hours', hours: [2, 14] }, at(9, 30)))
      .toBe(at(14));
  });

  it('allows two consecutive selected hours', () => {
    expect(computeNextEligibleTime(
      { lastBackupTime: at(14, 0, 20) },
      { interval: 'hours', hours: [14, 15] },
      at(14, 5),
    )).toBe(at(15));
  });

  it('rolls over to the first selected hour tomorrow', () => {
    expect(computeNextEligibleTime(
      { lastBackupTime: at(15, 0, 5) },
      { interval: 'hours', hours: [2, 14] },
      at(15, 30),
    )).toBe(at(2, 0, 0, 21));
  });

  it('is due right now on the top of a selected hour', () => {
    expect(computeNextEligibleTime(null, { interval: 'hours', hours: [14] }, at(14)))
      .toBe(at(14));
  });

  it('does not catch up a selected hour that already passed', () => {
    // Backed up at 02:00 yesterday, only 02:00 selected, now 09:30: the 02:00
    // slot today was missed (asleep, busy). Next chance is 02:00 tomorrow — a
    // catch-up at 09:30 would touch the drive outside the chosen hours.
    expect(computeNextEligibleTime(
      { lastBackupTime: at(2, 0, 10, 19) },
      { interval: 'hours', hours: [2] },
      at(9, 30),
    )).toBe(at(2, 0, 0, 21));
  });

  it('is due inside a selected hour, not only on its first second', () => {
    expect(computeNextEligibleTime(null, { interval: 'hours', hours: [14] }, at(14, 40)))
      .toBe(at(14));
  });

  it('never runs with no hours picked', () => {
    expect(computeNextEligibleTime(null, { interval: 'hours', hours: [] }, at(9, 30)))
      .toBe(Number.MAX_SAFE_INTEGER);
    expect(computeNextEligibleTime({ lastBackupTime: at(9) }, { interval: 'hours' }, at(9, 30)))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it('leaves the other intervals alone', () => {
    const last = new Date('2026-03-20T15:00:00').getTime();
    const result = computeNextEligibleTime({ lastBackupTime: last }, { interval: 'daily', timeOfDay: '03:00' });
    expect(new Date(result).getHours()).toBe(3);
    expect(result).toBeGreaterThan(last);
  });
});

describe('BackupCoordinator — checkAndQueueDue', () => {
  beforeEach(() => {
    resetCoordinator();
    mockPremium = true;
  });

  it('queues nothing without premium, however due the accounts are', () => {
    mockPremium = false;
    mockSettingsState.backupGlobalEnabled = true;
    mockSettingsState.backupGlobalConfig = { interval: 'hourly', hourlyInterval: 1 };
    mockSettingsState.backupSchedules = { 'acc-1': { enabled: true, interval: 'hourly', hourlyInterval: 1 } };
    mockSettingsState.backupState = { 'acc-1': { lastBackupTime: Date.now() - 2 * 3600_000 } };
    backupScheduler._queueRunning = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toEqual([]);
    // Negative control: same state, premium on — these accounts really are due.
    mockPremium = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toContain('acc-1');
    expect(backupScheduler._queue).toContain('acc-2');
    mockSettingsState.backupGlobalEnabled = false;
    mockSettingsState.backupGlobalConfig = { interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 };
    mockSettingsState.backupSchedules = {};
    mockSettingsState.backupState = {};
    backupScheduler._queueRunning = false;
  });

  it('queues accounts that are due for backup', () => {
    // Use hourly config to avoid timeOfDay alignment issues
    mockSettingsState.backupGlobalEnabled = true;
    mockSettingsState.backupGlobalConfig = { interval: 'hourly', hourlyInterval: 1 };
    mockSettingsState.backupState = {
      'acc-1': { lastBackupTime: Date.now() - 2 * 3600_000 }, // 2h ago, hourly is due
    };
    // Temporarily prevent processing
    backupScheduler._queueRunning = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toContain('acc-1');
    expect(backupScheduler._queue).toContain('acc-2'); // never backed up
    mockSettingsState.backupGlobalEnabled = false;
    mockSettingsState.backupGlobalConfig = { interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 };
    mockSettingsState.backupState = {};
    backupScheduler._queueRunning = false;
  });

  it('does not queue accounts that are not due', () => {
    mockSettingsState.backupGlobalEnabled = true;
    mockSettingsState.backupState = {
      'acc-1': { lastBackupTime: Date.now() - 1 * 3600_000 }, // 1h ago, daily not due
      'acc-2': { lastBackupTime: Date.now() - 1 * 3600_000 },
    };
    backupScheduler._queueRunning = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toEqual([]);
    mockSettingsState.backupGlobalEnabled = false;
    mockSettingsState.backupState = {};
    backupScheduler._queueRunning = false;
  });

  it('skips hidden accounts', () => {
    mockSettingsState.backupGlobalEnabled = true;
    mockSettingsState.hiddenAccounts = { 'acc-1': true };
    backupScheduler._queueRunning = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).not.toContain('acc-1');
    expect(backupScheduler._queue).toContain('acc-2'); // never backed up
    mockSettingsState.backupGlobalEnabled = false;
    mockSettingsState.hiddenAccounts = {};
    backupScheduler._queueRunning = false;
  });
});

// ── Recovery: a pause must actually resume ─────────────────────────────────
//
// 2026-09-10: two coordinator pauses (user-active, then the heartbeat's sleep
// detector) left the card on "Cancelled (2/9)" with three accounts queued for
// six hours. `_resumeInterrupted` re-queued the account and stopped there:
// `checkAndQueueDue` -> `queueBackup` returns early for an id already in the
// queue, BEFORE it reaches `_processQueue`, and `_processQueue` had already
// broken out of its loop on the pause. Asserting `_queue` contents proves
// nothing; these specs assert that something RUNS.

describe('BackupCoordinator — resume drives the queue', () => {
  beforeEach(resetCoordinator);

  const expectRanBothInOrder = () => {
    expect(api.backupRunAccount).toHaveBeenCalledTimes(2);
    expect(api.backupRunAccount.mock.calls[0]).toEqual(['acc-1', expect.any(String), null, 1]);
    expect(api.backupRunAccount.mock.calls[1][0]).toBe('acc-2');
    expect(backupScheduler._queue).toEqual([]);
    expect(backupScheduler.state).toBe(State.IDLE);
  };

  it('onWake after a sleep pause runs the interrupted account, then the rest of the queue', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._pausedAccountId = 'acc-1';
    backupScheduler._checkpoints.set('acc-1', 1);
    backupScheduler._queue = ['acc-2'];

    backupScheduler.onWake();
    await new Promise(r => setTimeout(r, 50));

    expectRanBothInOrder();
  });

  it('onOnline after an offline pause runs the interrupted account, then the rest of the queue', async () => {
    backupScheduler._state = State.PAUSED_OFFLINE;
    backupScheduler._pausedAccountId = 'acc-1';
    backupScheduler._checkpoints.set('acc-1', 1);
    backupScheduler._queue = ['acc-2'];

    backupScheduler.onOnline();
    await new Promise(r => setTimeout(r, 50));

    expectRanBothInOrder();
  });

  it('a throw inside _runBackup does not wedge the queue', async () => {
    // Today the rejection escapes `_processQueue` (the await sits outside
    // `_runBackup`'s try), so `_queueRunning` stays true forever and every
    // later queueBackup is a no-op. Swallow the unhandled rejection so the RED
    // run fails on the assertion, not on the process crashing.
    const swallow = () => {};
    process.on('unhandledRejection', swallow);
    try {
      const authUtils = await import('../../src/services/authUtils');
      authUtils.resolveServerAccount.mockRejectedValueOnce(new Error('boom'));

      backupScheduler.queueBackup('acc-1');
      await new Promise(r => setTimeout(r, 50));

      backupScheduler.queueBackup('acc-2');
      await new Promise(r => setTimeout(r, 50));

      expect(api.backupRunAccount).toHaveBeenCalledWith('acc-2', expect.any(String), null, 0);
      expect(backupScheduler._queueRunning).toBe(false);
      // The account that threw must not stay marked running: that alone would
      // block it from ever being queued again, and keep the stall watchdog
      // cancelling a run nobody started.
      expect(backupScheduler.isRunning('acc-1')).toBe(false);
    } finally {
      process.off('unhandledRejection', swallow);
    }
  });
});

// ── Recovery: the 60 s tick self-heals ────────────────────────────────────

describe('BackupCoordinator — tick self-heal', () => {
  beforeEach(resetCoordinator);

  it('exports the stall window it advertises', () => {
    expect(BACKUP_STALL_MS).toBe(15 * 60_000);
  });

  it('drives a populated idle queue', async () => {
    backupScheduler._queue = ['acc-1'];
    backupScheduler._queueRunning = false;
    backupScheduler._state = State.IDLE;

    backupScheduler.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).toHaveBeenCalledWith('acc-1', expect.any(String), null, 0);
  });

  it('leaves a paused queue alone', async () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._queue = ['acc-1'];

    backupScheduler.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).not.toHaveBeenCalled();
  });

  it('does not re-enter a running queue', async () => {
    backupScheduler._queueRunning = true;
    backupScheduler._queue = ['acc-1'];

    backupScheduler.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(api.backupRunAccount).not.toHaveBeenCalled();
  });

  it('cancels a run with no progress for 15 minutes', () => {
    backupScheduler._running.set('acc-1', true);
    backupScheduler._lastProgressAt = Date.now() - BACKUP_STALL_MS - 1000;

    backupScheduler.tick();

    expect(api.backupCancel).toHaveBeenCalledTimes(1);
    expect(backupScheduler._stalled.has('acc-1')).toBe(true);
  });

  it('leaves a run that is still making progress alone', () => {
    backupScheduler._running.set('acc-1', true);
    backupScheduler._lastProgressAt = Date.now();

    backupScheduler.tick();

    expect(api.backupCancel).not.toHaveBeenCalled();
    expect(backupScheduler._stalled.size).toBe(0);
  });

  it('leaves a stale stamp alone when nothing is running', () => {
    backupScheduler._lastProgressAt = Date.now() - BACKUP_STALL_MS - 1000;

    backupScheduler.tick();

    expect(api.backupCancel).not.toHaveBeenCalled();
  });
});

// ── Recovery: a stalled run is retried, not silently abandoned ────────────

describe('BackupCoordinator — a stalled run', () => {
  beforeEach(resetCoordinator);
  afterEach(() => { vi.useRealTimers(); });

  const stalledMessage = () => t('svc.backupScheduler.stalled', { minutes: 15 });

  /** First call: watchdog fires mid-run, Rust returns cancelled at folder 2. */
  const mockStalledOnce = () => {
    api.backupRunAccount.mockImplementationOnce(async () => {
      backupScheduler._stalled.add('acc-1');
      return { cancelled: true, completed_folders: 2, success: false, emails_backed_up: 0 };
    });
  };

  it('is retried from its checkpoint', async () => {
    vi.useFakeTimers();
    mockStalledOnce();
    api.backupRunAccount.mockResolvedValueOnce({ success: true, emails_backed_up: 1, duration_secs: 1 });

    backupScheduler.queueBackup('acc-1');
    await vi.advanceTimersByTimeAsync(10);

    expect(backupScheduler._retryCount.get('acc-1')).toBe(1);
    expect(backupScheduler._checkpoints.get('acc-1')).toBe(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10);

    expect(api.backupRunAccount).toHaveBeenCalledTimes(2);
    expect(api.backupRunAccount.mock.calls[1][3]).toBe(2);
    expect(backupScheduler._retryCount.has('acc-1')).toBe(false);
  });

  it('resolves a manual run as failed with the catalog message, and never retries it', async () => {
    vi.useFakeTimers();
    mockStalledOnce();

    const promise = backupScheduler.triggerManualBackup('acc-1');
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toEqual({ status: 'failed', message: stalledMessage() });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.backupRunAccount).toHaveBeenCalledTimes(1);
  });

  it('marks the account failed once the retries are spent', async () => {
    vi.useFakeTimers();
    backupScheduler._retryCount.set('acc-1', 3);
    mockStalledOnce();

    backupScheduler.queueBackup('acc-1');
    await vi.advanceTimersByTimeAsync(10);

    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastStatus: 'failed',
      lastError: stalledMessage(),
    }));
    expect(mockSettingsState.addBackupHistoryEntry).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.backupRunAccount).toHaveBeenCalledTimes(1);
  });

  it('leaves a server-side stop (bandwidth limit) reported as before', async () => {
    api.backupRunAccount.mockResolvedValueOnce({
      cancelled: true, completed_folders: 2, success: false,
      error_message: 'Gmail daily bandwidth limit reached',
    });
    const result = await backupScheduler.triggerManualBackup('acc-1');
    expect(result.status).toBe('cancelled');
    expect(mockSettingsState.updateBackupState).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastError: 'Gmail daily bandwidth limit reached',
    }));
  });

  it('discards a stall mark left from before the Rust run started', async () => {
    // The watchdog fired while this account was still resolving credentials:
    // that mark belongs to no run, and a later pause must not be read as a stall.
    backupScheduler._stalled.add('acc-1');
    api.backupRunAccount.mockResolvedValueOnce({ cancelled: true, completed_folders: 1, success: false });
    const result = await backupScheduler.triggerManualBackup('acc-1');
    expect(result.status).toBe('cancelled');
    expect(backupScheduler._stalled.size).toBe(0);
  });

  it('consumes the stall mark when a bandwidth stop lands after the watchdog fired', async () => {
    api.backupRunAccount.mockImplementationOnce(async () => {
      backupScheduler._stalled.add('acc-1');
      return {
        cancelled: true, completed_folders: 2, success: false,
        error_message: 'Gmail daily bandwidth limit reached',
      };
    });
    const result = await backupScheduler.triggerManualBackup('acc-1');
    expect(result.status).toBe('cancelled');
    expect(backupScheduler._stalled.size).toBe(0);
  });
});

// ── Recovery: the progress listener must not paint a finished run as active ─

describe('BackupCoordinator — progress listener', () => {
  beforeEach(resetCoordinator);
  afterEach(() => { vi.useRealTimers(); });

  it('the final backup-progress event clears the active flag', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    mockBackupState.activeBackup = {
      accountId: 'acc-1', active: true, folder: 'INBOX', totalFolders: 9, completedFolders: 1,
    };

    mockEventHandlers['backup-progress']({
      payload: progressPayload({
        folder: 'Cancelled', completed_folders: 2, completed_emails: 510, active: false,
      }),
    });

    expect(mockBackupState.activeBackup.active).toBe(false);
    expect(mockBackupState.activeBackup.folder).toBe('Cancelled');
  });

  it('flushes a payload caught inside the throttle window when the window closes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T00:00:00Z'));
    mockBackupState.activeBackup = { accountId: 'acc-1', active: true, folder: 'start' };

    mockEventHandlers['backup-progress']({ payload: progressPayload({ folder: 'INBOX' }) });
    expect(mockBackupState.activeBackup.folder).toBe('INBOX');

    vi.advanceTimersByTime(500);
    mockEventHandlers['backup-progress']({ payload: progressPayload({ folder: 'Sent' }) });
    expect(mockBackupState.activeBackup.folder).toBe('INBOX'); // throttled

    vi.advanceTimersByTime(2000);
    expect(mockBackupState.activeBackup.folder).toBe('Sent');
  });

  it('archive-progress stamps the progress time', () => {
    vi.useFakeTimers();
    const at = new Date('2030-01-03T00:00:00Z');
    vi.setSystemTime(at);

    mockEventHandlers['archive-progress']({ payload: { active: true, total: 10, completed: 3 } });

    expect(backupScheduler._lastProgressAt).toBe(at.getTime());
  });

  it('backup-progress stamps the progress time even when the update is throttled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-04T00:00:00Z'));
    mockBackupState.activeBackup = { accountId: 'acc-1', active: true, folder: 'start' };

    mockEventHandlers['backup-progress']({ payload: progressPayload({ folder: 'INBOX' }) });
    vi.advanceTimersByTime(100);
    const at = Date.now();
    mockEventHandlers['backup-progress']({ payload: progressPayload({ folder: 'Sent' }) });

    expect(backupScheduler._lastProgressAt).toBe(at);
  });
});
