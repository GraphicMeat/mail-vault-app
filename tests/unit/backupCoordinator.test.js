import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────

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
};
vi.mock('../../src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => mockSettingsState },
  hasPremiumAccess: () => false,
}));

// Mock backupStore
const mockBackupState = { activeBackup: null };
vi.mock('../../src/stores/backupStore', () => ({
  useBackupStore: {
    getState: () => ({
      ...mockBackupState,
      setActiveBackup: vi.fn((v) => { mockBackupState.activeBackup = v; }),
      clearActiveBackup: vi.fn(() => { mockBackupState.activeBackup = null; }),
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

const { backupScheduler, State, computeNextEligibleTime } = await import(
  '../../src/services/backupScheduler'
);
const api = await import('../../src/services/api');

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
  mockBackupState.activeBackup = null;
  vi.clearAllMocks();
}

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

  it('transitions to paused_user_active on onUserActive when running automatic', () => {
    backupScheduler._state = State.RUNNING;
    mockBackupState.activeBackup = { manual: false };
    backupScheduler.onUserActive();
    expect(backupScheduler.state).toBe(State.PAUSED_USER_ACTIVE);
  });

  it('does not pause manual backups on onUserActive', () => {
    backupScheduler._state = State.RUNNING;
    mockBackupState.activeBackup = { manual: true };
    backupScheduler.onUserActive();
    expect(backupScheduler.state).toBe(State.RUNNING);
  });

  it('resumes from paused_user_active on onUserIdle', () => {
    backupScheduler._state = State.PAUSED_USER_ACTIVE;
    backupScheduler.onUserIdle();
    expect(backupScheduler.state).toBe(State.IDLE);
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
    mockSettingsState.backupGlobalEnabled = true;
    backupScheduler.checkAndQueueDue();
    expect(backupScheduler._queue).toEqual([]);
    mailMod.useMailStore.getState = orig;
    mockSettingsState.backupGlobalEnabled = false;
  });

  it('checkAndQueueDue skips when paused', () => {
    backupScheduler._state = State.PAUSED_OFFLINE;
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

  it('resume re-queues interrupted account at front', () => {
    backupScheduler._state = State.PAUSED_SLEEP;
    backupScheduler._pausedAccountId = 'acc-1';
    backupScheduler._queue = ['acc-2'];
    backupScheduler.onWake();
    expect(backupScheduler._queue[0]).toBe('acc-1');
    expect(backupScheduler._queue[1]).toBe('acc-2');
  });
});

describe('BackupCoordinator — user-active pause resumes interrupted account on idle', () => {
  beforeEach(resetCoordinator);

  it('onUserIdle re-queues the interrupted account after user-active pause', () => {
    // Simulate: coordinator was running, user became active, backup was paused
    backupScheduler._state = State.PAUSED_USER_ACTIVE;
    backupScheduler._pausedAccountId = 'acc-1';
    backupScheduler._queue = [];

    backupScheduler.onUserIdle();

    expect(backupScheduler.state).toBe(State.IDLE);
    expect(backupScheduler._queue[0]).toBe('acc-1');
    expect(backupScheduler._pausedAccountId).toBeNull();
  });

  it('onUserIdle without a paused account just resumes without queuing', () => {
    backupScheduler._state = State.PAUSED_USER_ACTIVE;
    backupScheduler._pausedAccountId = null;

    backupScheduler.onUserIdle();

    expect(backupScheduler.state).toBe(State.IDLE);
    expect(backupScheduler._queue).toEqual([]);
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

describe('BackupCoordinator — checkAndQueueDue', () => {
  beforeEach(resetCoordinator);

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
