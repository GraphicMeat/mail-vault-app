// @vitest-environment jsdom
// Settings > Backup & Restore > Archive & delete: the two cards, their gating,
// and the hand-off to the setup screen.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ accounts: [] }));
vi.mock('../../../stores/accountStore', () => ({
  useAccountStore: (selector) => selector({ accounts: h.accounts }),
  getAccounts: () => h.accounts,
}));
const svc = vi.hoisted(() => ({
  watchAbd: vi.fn(async () => () => {}),
  beginPreview: vi.fn(async () => 'p1'),
  summarize: vi.fn(async () => ({})),
  startJob: vi.fn(async () => ({})),
}));
vi.mock('../../../services/abd', () => svc);

import AbdSection from '../abd/AbdSection';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useAbdStore } from '../../../stores/abdStore';
import { t } from '../../../i18n';
import { usePrivacyStore } from '../../../stores/privacyStore';

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const READY = { displayPath: '/Volumes/Backup', status: 'ready', platform: 'macos', lastValidatedAt: 1, lastError: null };
const LUKE = { id: 'acc-luke', email: 'luke@mock.test', authType: 'password' };
const LEIA = { id: 'acc-leia', email: 'leia@outlook.test', authType: 'oauth2', oauth2Transport: 'graph' };

const job = (over = {}) => ({
  jobId: 'abd-1', accountId: LUKE.id, accountEmail: LUKE.email, mode: 'archive_delete', deleteMode: 'move_to_trash',
  status: { state: 'running', phase: 'download' },
  counts: { scoped: 10, stored: 1, vaultVerified: 1, onDrive: 0, deleted: 0, emptied: 0, kept: 0, keptByReason: {} },
  finished: false, outcome: null, error: null, updatedMs: 1, ...over,
});

const setUpBackup = () => screen.getByTestId('abd-setup-backup');
const setUpArchive = () => screen.getByTestId('abd-setup-archive');

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [LUKE, LEIA];
  useSettingsStore.setState({ billingProfile: PREMIUM, externalBackupLocation: READY, hiddenAccounts: {}, accountOrder: [] });
  useAbdStore.setState({ jobs: {}, previews: {}, panel: null });
});
afterEach(cleanup);

describe('the two cards', () => {
  it('carry the Premium badge, each with its own title and description', () => {
    render(<AbdSection />);
    for (const [id, title, desc] of [
      ['abd-card-backup', 'settings.backup.abd.backupCard.title', 'settings.backup.abd.backupCard.desc'],
      ['abd-card-archive', 'settings.backup.abd.archiveCard.title', 'settings.backup.abd.archiveCard.desc'],
    ]) {
      const card = within(screen.getByTestId(id));
      expect(card.getByText(t('common.premium'))).toBeTruthy();
      expect(card.getByText(t(title))).toBeTruthy();
      expect(card.getByText(t(desc))).toBeTruthy();
    }
  });

  it('name the vault as the only copy on the archive-only card, with a way to the backup card', () => {
    render(<AbdSection />);
    expect(screen.getByTestId('abd-only-copy').textContent).toContain(t('settings.backup.abd.onlyCopyNote'));
    expect(screen.getByTestId('abd-backup-wrap').getAttribute('data-pointed')).toBeNull();
    fireEvent.click(screen.getByTestId('abd-use-backup'));
    expect(screen.getByTestId('abd-backup-wrap').getAttribute('data-pointed')).toBe('true');
  });
});

describe('gating', () => {
  it('without Premium, Set up explains and offers the upgrade instead of opening the setup', () => {
    useSettingsStore.setState({ billingProfile: null });
    const onUpgrade = vi.fn();
    render(<AbdSection onUpgrade={onUpgrade} />);
    expect(screen.queryByTestId('abd-upsell')).toBeNull();

    fireEvent.click(setUpArchive());
    const upsell = screen.getByTestId('abd-upsell');
    expect(upsell.textContent).toContain(t('settings.backup.abd.upsell'));
    expect(screen.queryByTestId('abd-setup')).toBeNull();
    expect(svc.beginPreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('abd-upgrade'));
    expect(onUpgrade).toHaveBeenCalledOnce();
  });

  it('shows the upsell on the backup card too, under that card', () => {
    useSettingsStore.setState({ billingProfile: null });
    render(<AbdSection onUpgrade={() => {}} />);
    fireEvent.click(setUpBackup());
    expect(within(screen.getByTestId('abd-card-backup')).getByTestId('abd-upsell')).toBeTruthy();
  });

  it('disables Archive, back up & delete with its reason when no backup folder is set', () => {
    useSettingsStore.setState({ externalBackupLocation: null });
    render(<AbdSection />);
    expect(setUpBackup().disabled).toBe(true);
    expect(screen.getByTestId('abd-needs-backup').textContent).toBe(t('settings.backup.abd.needsBackupFolder'));
  });

  it('treats a folder that is not ready (drive away, permission lost) as no folder', () => {
    useSettingsStore.setState({ externalBackupLocation: { ...READY, status: 'unavailable' } });
    render(<AbdSection />);
    expect(setUpBackup().disabled).toBe(true);
    expect(screen.getByTestId('abd-needs-backup')).toBeTruthy();
  });

  it('leaves Archive & delete enabled without a backup folder', () => {
    useSettingsStore.setState({ externalBackupLocation: null });
    render(<AbdSection />);
    expect(setUpArchive().disabled).toBe(false);
  });

  it('with Premium and a backup folder, both open their setup for the chosen account', async () => {
    const { unmount } = render(<AbdSection />);
    expect(screen.queryByTestId('abd-needs-backup')).toBeNull();
    fireEvent.click(setUpBackup());
    expect(screen.getByTestId('abd-setup')).toBeTruthy();
    await waitFor(() => expect(svc.beginPreview).toHaveBeenCalledWith(LUKE.id));
    unmount();

    render(<AbdSection />);
    fireEvent.change(screen.getByTestId('abd-account'), { target: { value: LEIA.id } });
    fireEvent.click(setUpArchive());
    await waitFor(() => expect(svc.beginPreview).toHaveBeenCalledWith(LEIA.id));
  });

  it('Back from the setup returns to the cards', () => {
    render(<AbdSection />);
    fireEvent.click(setUpArchive());
    fireEvent.click(screen.getByTestId('abd-back'));
    expect(screen.queryByTestId('abd-setup')).toBeNull();
    expect(screen.getByTestId('abd-card-archive')).toBeTruthy();
  });
});

describe('accounts', () => {
  it('lists the visible accounts and hides the ones hidden in Settings', () => {
    useSettingsStore.setState({ hiddenAccounts: { [LEIA.id]: true } });
    render(<AbdSection />);
    const options = [...screen.getByTestId('abd-account').querySelectorAll('option')].map(o => o.textContent);
    expect(options).toEqual([LUKE.email]);
  });

  it('says an Outlook account needs the app open, and says nothing for the others', () => {
    render(<AbdSection />);
    expect(screen.queryByTestId('abd-graph-hint')).toBeNull();
    fireEvent.change(screen.getByTestId('abd-account'), { target: { value: LEIA.id } });
    expect(screen.getByTestId('abd-graph-hint').textContent).toBe(t('settings.backup.abd.graphHint'));
  });

  it('says so when there is no account', () => {
    h.accounts = [];
    render(<AbdSection />);
    expect(screen.getByTestId('abd-no-accounts').textContent).toContain(t('common.noAccountsConfigured'));
  });
});

describe('a job on the account', () => {
  it('shows it as running, blocks a second one, and opens the panel from Show progress', () => {
    useAbdStore.setState({ jobs: { [LUKE.id]: job() } });
    render(<AbdSection />);
    expect(screen.getByTestId('abd-job-line').textContent).toContain(t('settings.backup.abd.jobRunning'));
    expect(setUpBackup().disabled).toBe(true);
    expect(setUpArchive().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('abd-show-progress'));
    expect(useAbdStore.getState().panel).toEqual({ accountId: LUKE.id, minimized: false });
  });

  it('a finished job no longer blocks Set up, and Show progress reaches its result', () => {
    useAbdStore.setState({ jobs: { [LUKE.id]: job({ finished: true, outcome: 'completed', status: { state: 'completed' } }) } });
    render(<AbdSection />);
    expect(screen.getByTestId('abd-job-line').textContent).toContain(t('abd.status.completed'));
    expect(setUpArchive().disabled).toBe(false);
    expect(screen.getByTestId('abd-show-progress')).toBeTruthy();
  });

  it('another account\'s job does not block this one', () => {
    useAbdStore.setState({ jobs: { [LEIA.id]: job({ accountId: LEIA.id }) } });
    render(<AbdSection />);
    expect(screen.queryByTestId('abd-job-line')).toBeNull();
    expect(setUpArchive().disabled).toBe(false);
  });
});

describe('a Settings window of its own', () => {
  afterEach(() => { delete document.body.dataset.auxiliaryWindow; });

  it('offers no Show progress there: the panel lives in the main window only', () => {
    // main.jsx marks the Settings window this way before it renders.
    document.body.dataset.auxiliaryWindow = 'settings';
    useAbdStore.setState({ jobs: { [LUKE.id]: job() } });
    render(<AbdSection />);
    expect(screen.getByTestId('abd-job-line').textContent).toContain(t('settings.backup.abd.jobRunning'));
    expect(screen.queryByTestId('abd-show-progress')).toBeNull();
  });

  it('follows the job frames while it is open and stops when it closes', async () => {
    const stop = vi.fn();
    svc.watchAbd.mockResolvedValueOnce(stop);
    const view = render(<AbdSection />);
    await waitFor(() => expect(svc.watchAbd).toHaveBeenCalledOnce());
    view.unmount();
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });
});

describe('privacy mode', () => {
  it('masks the account choices', () => {
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
    usePrivacyStore.setState({ enabled: true });
    try {
      render(<AbdSection />);
      const options = [...screen.getByTestId('abd-account').querySelectorAll('option')].map(o => o.textContent);
      expect(options).toEqual(['xxxx@xxxx.xxxx', 'xxxx@xxxxxxx.xxxx']);
    } finally {
      usePrivacyStore.setState({ enabled: false });
      vi.restoreAllMocks();
    }
  });
});
