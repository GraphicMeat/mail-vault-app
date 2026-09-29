// @vitest-environment jsdom
// The progress panel and its minimized pill for an Archive & delete job.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const svc = vi.hoisted(() => ({
  pause: vi.fn(async () => ({})),
  resume: vi.fn(async () => ({})),
  cancel: vi.fn(async () => ({})),
  dismiss: vi.fn(async () => ({})),
}));
vi.mock('../../../services/abd', () => svc);
const h = vi.hoisted(() => ({ accounts: [] }));
vi.mock('../../../stores/accountStore', () => ({
  useAccountStore: (selector) => selector({ accounts: h.accounts }),
  getAccounts: () => h.accounts,
}));

import { AbdProgressPanel } from '../AbdProgressPanel';
import { AbdPill } from '../AbdPill';
import { useAbdStore } from '../../../stores/abdStore';
import { formatResumeTime, KEPT_KEYS, PAUSE_KEYS, WAIT_KEYS } from '../abdText';
import { formatDateTime, formatTime } from '../../../utils/dateFormat';
import { t } from '../../../i18n';
import en from '../../../i18n/locales/en.json';

const frame = (over = {}) => ({
  jobId: 'abd-acc-1', accountId: 'acc', accountEmail: 'luke@mock.test', mode: 'archive_backup_delete',
  timing: 'after_all', deleteMode: 'move_to_trash', provider: 'imap',
  status: { state: 'running', phase: 'download' },
  counts: { scoped: 1200, scopedBytes: 1, stored: 900, vaultVerified: 880, onDrive: 870, deleted: 12, emptied: 0, kept: 0, keptByReason: {} },
  downloadedBytes: 5, remainingBytes: 5, daysLeft: null, dailyLimitBytes: null,
  currentFolder: 'INBOX', staleFolders: [], providerLimitSinceMs: null,
  finished: false, outcome: null, error: null, updatedMs: 100, ...over,
});

const Host = () => <><AbdProgressPanel /><AbdPill /></>;
const show = (over, { minimized = false } = {}) => {
  useAbdStore.setState({ jobs: { acc: frame(over) }, previews: {}, panel: { accountId: 'acc', minimized } });
  return render(<Host />);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [];
  useAbdStore.setState({ jobs: {}, previews: {}, panel: null, focusPill: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('panel', () => {
  it('names the account and the mode in its title', () => {
    show();
    expect(screen.getByTestId('abd-panel-title').textContent).toBe(t('abd.panel.titleBackup', { account: 'luke@mock.test' }));
    cleanup();
    show({ mode: 'archive_delete' });
    expect(screen.getByTestId('abd-panel-title').textContent).toBe(t('abd.panel.title', { account: 'luke@mock.test' }));
  });

  it('names the account from the account list when the frame carries no email (a job it could not read)', () => {
    h.accounts = [{ id: 'acc', email: 'luke@mock.test' }];
    show({ accountEmail: null });
    expect(screen.getByTestId('abd-panel-title').textContent).toBe(t('abd.panel.titleBackup', { account: 'luke@mock.test' }));
  });

  it('never names the account "null" when it is not in the list either', () => {
    show({ accountEmail: null });
    expect(screen.getByTestId('abd-panel-title').textContent).toBe(t('abd.panel.titleBackup', { account: '' }));
    expect(screen.getByTestId('abd-panel-title').textContent).not.toContain('null');
  });

  it('counts each phase against the scoped total', () => {
    show();
    expect(within(screen.getByTestId('abd-row-downloaded')).getByText(/900/).textContent).toContain('1,200');
    expect(screen.getByTestId('abd-row-vault').textContent).toContain('880');
    expect(screen.getByTestId('abd-row-drive').textContent).toContain('870');
    expect(screen.getByTestId('abd-row-deleted').textContent).toContain('12');
    expect(screen.queryByTestId('abd-row-emptied')).toBeNull();
  });

  it('has no drive row for an archive-only job, and a Trash row only when it empties the Trash', () => {
    show({ mode: 'archive_delete', deleteMode: 'move_to_trash_and_empty' });
    expect(screen.queryByTestId('abd-row-drive')).toBeNull();
    expect(screen.getByTestId('abd-row-emptied')).toBeTruthy();
  });

  it('says how many days are left at the daily limit', () => {
    show({ daysLeft: 3, dailyLimitBytes: 2000 * 1024 * 1024 });
    expect(screen.getByTestId('abd-days-left').textContent).toContain('3');
  });

  it('warns about a folder that changed on the server', () => {
    show({ staleFolders: ['INBOX'] });
    expect(screen.getByTestId('abd-stale').textContent).toBe(t('abd.panel.folderChanged'));
  });
});

describe('status line', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 29, 12, 0, 0)); });

  it('shows a resume time later today as a time of day, in the local zone', () => {
    const until = new Date(2026, 8, 29, 15, 30, 0).getTime();
    show({ status: { state: 'waiting', reason: 'daily_limit', untilMs: until } });
    expect(screen.getByTestId('abd-status').textContent).toBe(t('abd.wait.daily_limit', { time: formatTime(until) }));
  });

  it('shows a resume time on another day with its date', () => {
    const until = new Date(2026, 8, 30, 0, 1, 0).getTime();
    show({ status: { state: 'waiting', reason: 'daily_limit', untilMs: until } });
    expect(formatResumeTime(until)).toBe(formatDateTime(until));
    expect(screen.getByTestId('abd-status').textContent).toBe(t('abd.wait.daily_limit', { time: formatDateTime(until) }));
  });

  it('says every wait and every pause in its own words', () => {
    for (const [reason, key] of Object.entries(WAIT_KEYS)) {
      show({ status: { state: 'waiting', reason, untilMs: Date.now() + 60_000 } });
      expect(screen.getByTestId('abd-status').textContent, reason).toBe(t(key, { time: formatResumeTime(Date.now() + 60_000) }));
      cleanup();
    }
    for (const [reason, key] of Object.entries(PAUSE_KEYS)) {
      show({ status: { state: 'paused', reason } });
      expect(screen.getByTestId('abd-status').textContent, reason).toBe(t(key));
      cleanup();
    }
  });

  it('shows the sign-in and drive states with a Resume button', () => {
    show({ status: { state: 'paused', reason: 'sign_in_needed' } });
    expect(screen.getByTestId('abd-status').textContent).toBe(t('abd.pause.sign_in_needed'));
    expect(screen.getByTestId('abd-resume')).toBeTruthy();
    cleanup();
    show({ status: { state: 'paused', reason: 'drive_unavailable' } });
    expect(screen.getByTestId('abd-status').textContent).toBe(t('abd.pause.drive_unavailable'));
  });

  it('shows why a job stopped', () => {
    show({ finished: true, outcome: 'failed', error: 'disk full', status: { state: 'failed', error: 'disk full' } });
    expect(screen.getByTestId('abd-status').textContent).toBe(t('abd.status.failed', { error: 'disk full' }));
  });
});

describe('kept on the server', () => {
  it('lists each reason with its count', () => {
    show({ counts: { ...frame().counts, kept: 6, keptByReason: { download_failed: 5, server_changed: 1 } } });
    const kept = screen.getByTestId('abd-kept');
    expect(kept.textContent).toContain(t('abd.panel.kept', { count: 6 }));
    expect(within(screen.getByTestId('abd-kept-download_failed')).getByText(t('abd.kept.download_failed'))).toBeTruthy();
    expect(screen.getByTestId('abd-kept-download_failed').textContent).toContain('5');
    expect(screen.getByTestId('abd-kept-server_changed').textContent).toContain(t('abd.kept.server_changed'));
  });

  it('has no list when nothing was kept', () => {
    show();
    expect(screen.queryByTestId('abd-kept')).toBeNull();
  });

  it('every reason the daemon can send has words in the catalog', () => {
    for (const key of [...Object.values(KEPT_KEYS), ...Object.values(WAIT_KEYS), ...Object.values(PAUSE_KEYS)]) {
      expect(en[key], key).toBeTruthy();
    }
  });
});

describe('minimize and the pill', () => {
  it('Minimize hides the panel and shows the pill; the pill brings the panel back', () => {
    show();
    expect(screen.queryByTestId('abd-pill')).toBeNull();
    fireEvent.click(screen.getByTestId('abd-minimize'));
    expect(screen.queryByTestId('abd-panel')).toBeNull();
    expect(screen.getByTestId('abd-pill')).toBeTruthy();
    fireEvent.click(screen.getByTestId('abd-pill-restore'));
    expect(screen.getByTestId('abd-panel')).toBeTruthy();
    expect(screen.queryByTestId('abd-pill')).toBeNull();
  });

  it('the pill shows the percent of a running job', () => {
    show({ counts: { ...frame().counts, scoped: 100, vaultVerified: 100, onDrive: 100, deleted: 0 } }, { minimized: true });
    expect(screen.getByTestId('abd-pill').textContent).toBe(t('abd.pill', { percent: 66 }));
  });

  it('the pill shows the short waiting text while the job waits or is paused', () => {
    show({ status: { state: 'waiting', reason: 'daily_limit', untilMs: Date.now() + 1000 } }, { minimized: true });
    expect(screen.getByTestId('abd-pill').textContent).toBe(t('abd.pillWaiting'));
    cleanup();
    show({ status: { state: 'paused', reason: 'user' } }, { minimized: true });
    expect(screen.getByTestId('abd-pill').textContent).toBe(t('abd.pillWaiting'));
  });

  it('minimizing, restoring and unmounting never stop the job', () => {
    const view = show();
    fireEvent.click(screen.getByTestId('abd-minimize'));
    fireEvent.click(screen.getByTestId('abd-pill-restore'));
    view.unmount();
    expect(svc.cancel).not.toHaveBeenCalled();
    expect(svc.pause).not.toHaveBeenCalled();
    expect(svc.dismiss).not.toHaveBeenCalled();
    expect(useAbdStore.getState().jobs.acc).toBeTruthy();
  });

  it('Minimize hands keyboard focus to the pill', () => {
    show();
    screen.getByTestId('abd-minimize').focus();
    fireEvent.click(screen.getByTestId('abd-minimize'));
    expect(document.activeElement).toBe(screen.getByTestId('abd-pill-restore'));
    expect(useAbdStore.getState().focusPill).toBe(false);
  });

  it('a pill that appears by itself (a job started elsewhere) takes no focus', () => {
    show(undefined, { minimized: true });
    expect(screen.getByTestId('abd-pill')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('renders nothing when there is no panel', () => {
    useAbdStore.setState({ jobs: { acc: frame() }, panel: null });
    render(<Host />);
    expect(screen.queryByTestId('abd-panel')).toBeNull();
    expect(screen.queryByTestId('abd-pill')).toBeNull();
  });
});

describe('pause, resume, cancel', () => {
  it('Pause asks the service to pause this account', async () => {
    show();
    fireEvent.click(screen.getByTestId('abd-pause'));
    await waitFor(() => expect(svc.pause).toHaveBeenCalledWith('acc'));
  });

  it('a paused job offers Resume instead of Pause', async () => {
    show({ status: { state: 'paused', reason: 'user' } });
    expect(screen.queryByTestId('abd-pause')).toBeNull();
    fireEvent.click(screen.getByTestId('abd-resume'));
    await waitFor(() => expect(svc.resume).toHaveBeenCalledWith('acc'));
  });

  it('Cancel asks first; Keep running backs out, and only the confirmation cancels', async () => {
    show();
    fireEvent.click(screen.getByTestId('abd-cancel'));
    expect(screen.getByTestId('abd-cancel-confirm').textContent).toContain(t('abd.action.cancelConfirm'));
    expect(svc.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(t('abd.action.keepRunning')));
    expect(screen.queryByTestId('abd-cancel-confirm')).toBeNull();
    expect(svc.cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('abd-cancel'));
    fireEvent.click(screen.getByTestId('abd-cancel-yes'));
    await waitFor(() => expect(svc.cancel).toHaveBeenCalledWith('acc'));
  });

  it('Cancel moves focus to Keep running, and Keep running gives it back to Cancel', () => {
    show();
    screen.getByTestId('abd-cancel').focus();
    fireEvent.click(screen.getByTestId('abd-cancel'));
    expect(document.activeElement).toBe(screen.getByTestId('abd-keep-running'));
    fireEvent.click(screen.getByTestId('abd-keep-running'));
    expect(screen.queryByTestId('abd-cancel-confirm')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('abd-cancel'));
  });

  it('shows the daemon\'s refusal instead of swallowing it', async () => {
    // In English tErr shows the daemon's own sentence (the tail after the code); other languages get the catalog's.
    svc.pause.mockRejectedValueOnce(new Error('E_ABD_JOB_EXISTS: the daemon says no'));
    show();
    fireEvent.click(screen.getByTestId('abd-pause'));
    expect((await screen.findByRole('alert')).textContent).toContain('the daemon says no');
  });
});

describe('a finished job', () => {
  const done = { finished: true, outcome: 'completed', status: { state: 'completed' } };

  it('offers Close, which dismisses the job, and no Pause or Cancel', async () => {
    show(done);
    expect(screen.getByTestId('abd-status').textContent).toBe(t('abd.status.completed'));
    expect(screen.queryByTestId('abd-pause')).toBeNull();
    expect(screen.queryByTestId('abd-cancel')).toBeNull();
    expect(screen.queryByTestId('abd-minimize')).toBeNull();
    fireEvent.click(screen.getByTestId('abd-done'));
    await waitFor(() => expect(svc.dismiss).toHaveBeenCalledWith('acc'));
  });
});
