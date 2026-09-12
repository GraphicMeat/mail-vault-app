// @vitest-environment jsdom

/**
 * The account card is the only surface that says whether a backup is happening.
 *
 * 2026-09-12: thirteen accounts sat queued for three hours while every card read
 * "Back up now" and did nothing, because the card only knew about runs it had
 * started itself. It now reads `activeBackup` and `queue` out of the backup
 * store, so whoever started the run - the schedule, "Back up all", or this card
 * - is what these specs drive.
 *
 * The branch under test is `scheduleContent`: a premium user with the global
 * schedule off, which is what the Backup Schedule sub-tab renders by default.
 * The `globalEnabled` branch renders the same three testids over a smaller
 * layout, and the free branch renders `scheduleContent` behind a paywall.
 *
 * lucide-react and framer-motion are deliberately NOT mocked - the card renders
 * icons and an AnimatePresence block, and both work in jsdom here.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// The card's own progress listener. Captured so a spec can fire Rust's events.
const eventHandlers = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => { eventHandlers[name] = cb; return () => {}; }),
}));

const triggerManualBackup = vi.fn().mockResolvedValue({ status: 'success' });
vi.mock('../../../services/backupScheduler', () => ({
  backupScheduler: { triggerManualBackup: (...a) => triggerManualBackup(...a) },
}));
vi.mock('../../../services/api', () => ({ backupStatus: vi.fn() }));
vi.mock('../../../services/authUtils', () => ({ resolveServerAccount: vi.fn() }));
vi.mock('../../../hooks/usePremiumPricing.js', () => ({ usePremiumPriceBlurb: () => '' }));

const { default: BackupAccountCard } = await import('../BackupAccountCard');
const { useBackupStore } = await import('../../../stores/backupStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');

const ACCOUNT = { id: 'acc-luke', email: 'luke@mock.test' };
const OTHER = 'acc-vader';

/** The store's shape for a run that has started but reported no totals yet. */
const activeRun = (over = {}) => ({
  accountId: ACCOUNT.id,
  accountEmail: ACCOUNT.email,
  folder: '',
  totalFolders: 0,
  completedFolders: 0,
  completedEmails: 0,
  active: true,
  ...over,
});

const button = () => screen.getByTestId('backup-now-button');
const progress = () => screen.queryByTestId('backup-card-progress');

function renderCard() {
  // `globalEnabled` false and `isPaidUser` true: the branch the Backup Schedule
  // sub-tab renders for a premium user who has not turned the global schedule on.
  return render(<BackupAccountCard account={ACCOUNT} isPaidUser globalEnabled={false} />);
}

let settingsSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of Object.keys(eventHandlers)) delete eventHandlers[name];
  settingsSnapshot = useSettingsStore.getState();
  useSettingsStore.setState({
    backupSchedules: {}, backupState: {}, backupHistory: {}, accountColors: {},
    upsellBackupShown: false, backupScope: 'archived',
  });
  useBackupStore.setState({ activeBackup: null, queue: [] });
});
afterEach(() => {
  cleanup();
  useBackupStore.setState({ activeBackup: null, queue: [] });
  useSettingsStore.setState(settingsSnapshot, true);
});

describe('BackupAccountCard - the run the store knows about', () => {
  it('reads Queued... and refuses a second click while the id waits in the queue', () => {
    useBackupStore.setState({ queue: [OTHER, ACCOUNT.id] });
    renderCard();

    expect(button().textContent).toContain('Queued...');
    expect(button().disabled).toBe(true);
    expect(progress()).toBe(null);
  });

  it('shows an indeterminate bar before Rust reports any folder totals', () => {
    useBackupStore.setState({ activeBackup: activeRun() });
    renderCard();

    const bar = screen.getByTestId('backup-card-bar');
    expect(progress()).not.toBe(null);
    expect(progress().contains(bar)).toBe(true);
    expect(bar.className).toContain('animate-pulse');
    expect(bar.style.width).toBe('');
    expect(button().textContent).toContain('Backing up...');
    expect(button().disabled).toBe(true);
  });

  it('measures the bar once the totals arrive', () => {
    useBackupStore.setState({
      activeBackup: activeRun({ folder: 'INBOX', totalFolders: 9, completedFolders: 3, completedEmails: 120 }),
    });
    renderCard();

    const bar = screen.getByTestId('backup-card-bar');
    expect(bar.style.width).toBe('33%');
    expect(bar.className).not.toContain('animate-pulse');
    expect(progress().textContent).toContain('(3/9');
  });

  it('drops the progress block for the three-second Complete tail', () => {
    // `done` is the coordinator saying "finished, read this for a moment" - not
    // a live run. A card that treats it as one stays disabled after the work is
    // over, which is how "Back up all accounts now" stayed grey for six hours.
    useBackupStore.setState({ activeBackup: activeRun({ folder: 'Complete', done: true }) });
    renderCard();

    expect(progress()).toBe(null);
    expect(button().disabled).toBe(false);
  });

  it('ignores a finished progress event while the store still says the run is live', async () => {
    useBackupStore.setState({ activeBackup: activeRun({ folder: 'Archive', totalFolders: 9, completedFolders: 3 }) });
    renderCard();
    await waitFor(() => expect(typeof eventHandlers['backup-progress']).toBe('function'));

    eventHandlers['backup-progress']({
      payload: {
        account_id: ACCOUNT.id, folder: 'Complete', total_folders: 9,
        completed_folders: 9, completed_emails: 500, active: false,
      },
    });

    // The card's own event is richer, but only while it is live. A stale
    // `active: false` must not repaint the run the store is still reporting.
    await waitFor(() => expect(progress().textContent).toContain('Archive'));
    expect(progress().textContent).toContain('(3/9');
  });

  it('stays out of the way when the run belongs to another account', () => {
    useBackupStore.setState({ activeBackup: activeRun({ accountId: OTHER, accountEmail: 'vader@mock.test' }) });
    renderCard();

    expect(progress()).toBe(null);
    expect(button().disabled).toBe(false);
  });
});
