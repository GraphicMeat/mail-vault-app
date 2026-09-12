// @vitest-environment jsdom

/**
 * "Back up all accounts now" is one button with two jobs: start the work, and
 * then stay out of the way until it is done. It got both wrong on 2026-09-12 -
 * it pushed its manual ids behind a queue nothing was draining, and it greyed
 * itself out on an `activeBackup` that had already finished.
 *
 * The panel is what these specs drive; the per-account card has its own file,
 * so it is stubbed here to keep this one on the panel's three states.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../services/backupScheduler', () => ({
  backupScheduler: { triggerManualBackup: vi.fn() },
}));
vi.mock('../BackupAccountCard', () => ({
  default: React.forwardRef(function StubCard({ account }, ref) {
    return <div ref={ref} data-testid="backup-account-card" data-account-id={account.id} />;
  }),
}));

const { default: BackupSchedule } = await import('../BackupSchedule');
const { useBackupStore } = await import('../../../stores/backupStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');

const ACCOUNT = { id: 'acc-luke', email: 'luke@mock.test' };

const allButton = () => screen.getByTestId('backup-all-button');

let settingsSnapshot;
let mailSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  settingsSnapshot = useSettingsStore.getState();
  mailSnapshot = useMailStore.getState();
  useMailStore.setState({ accounts: [ACCOUNT] });
  useSettingsStore.setState({
    hiddenAccounts: {}, accountOrder: [], backupGlobalEnabled: false,
    backupGlobalConfig: { interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 },
    billingProfile: { premiumAccess: true, clientAccessGranted: true, hasSubscription: true, status: 'active' },
  });
  useBackupStore.setState({ activeBackup: null, queue: [] });
});
afterEach(() => {
  cleanup();
  useBackupStore.setState({ activeBackup: null, queue: [] });
  useSettingsStore.setState(settingsSnapshot, true);
  useMailStore.setState(mailSnapshot, true);
});

describe('BackupSchedule - the Back up all panel', () => {
  it('keeps a bar on screen for the window before Rust reports any totals', () => {
    useBackupStore.setState({
      activeBackup: {
        accountId: ACCOUNT.id, accountEmail: ACCOUNT.email, folder: 'Starting...',
        totalFolders: 0, completedFolders: 0, completedEmails: 0, active: true, queueLength: 0,
      },
    });
    render(<BackupSchedule />);

    const panel = screen.getByTestId('backup-all-progress');
    const bar = screen.getByTestId('backup-all-bar');
    expect(panel.contains(bar)).toBe(true);
    expect(bar.className).toContain('animate-pulse');
    expect(bar.style.width).toBe('');
  });

  it('refuses a second click while ids are still queued and nothing is running yet', () => {
    // The gap between "Back up all" queueing 13 ids and the first run starting
    // is exactly where a second click doubled the work.
    useBackupStore.setState({ queue: ['acc-vader'], activeBackup: null });
    render(<BackupSchedule />);

    expect(allButton().disabled).toBe(true);
    expect(screen.queryByTestId('backup-all-progress')).toBe(null);
  });

  it('is clickable with an empty queue and nothing running', () => {
    render(<BackupSchedule />);

    expect(allButton().disabled).toBe(false);
    expect(allButton().textContent).toContain('Back up all accounts now');
  });
});
