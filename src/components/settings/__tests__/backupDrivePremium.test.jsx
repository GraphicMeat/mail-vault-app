// @vitest-environment jsdom
//
// Backup to another drive is Premium in the direct build (2026-11-25). Without
// Premium the daemon writes nothing to the drive, so Settings must not offer a
// picker that silently does nothing: no location means a locked upsell, a
// location already set means a calm "paused" notice that still lets the user
// remove it. The App Store build keeps its own one-time purchase, unchanged.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../../services/workflows/bindStoreActions';

const buildFlags = { IS_APPSTORE_BUILD: false };
vi.mock('../../../utils/buildFlags', async (importOriginal) => ({
  ...(await importOriginal()),
  get IS_APPSTORE_BUILD() { return buildFlags.IS_APPSTORE_BUILD; },
}));
vi.mock('../../../services/transport', () => ({ send: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../../../hooks/usePremiumPricing.js', () => ({ usePremiumPriceBlurb: () => 'PRICE-BLURB' }));
vi.mock('../MailStorageLocation', () => ({ default: () => <div data-testid="mail-location" /> }));
vi.mock('../BackupLocationPicker', () => ({ default: () => <div data-testid="backup-picker" /> }));

const { default: BackupConfig } = await import('../BackupConfig');
const { default: BackupVerificationTree } = await import('../BackupVerificationTree');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { t } = await import('../../../i18n');
const { default: en } = await import('../../../i18n/locales/en.json');

const PREMIUM = { hasSubscription: true, status: 'active' };
const LAPSED = { hasSubscription: true, status: 'canceled', currentPeriodEnd: '2020-01-01T00:00:00Z' };
const DRIVE = { status: 'ready', displayPath: '/Volumes/Backup' };

const invoke = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  buildFlags.IS_APPSTORE_BUILD = false;
  window.__TAURI__ = { core: { invoke } };
  invoke.mockResolvedValue(undefined);
  useSettingsStore.setState({ billingProfile: null, shareGrant: null, externalBackupLocation: null, backupCustomPath: null });
});
afterEach(() => { cleanup(); delete window.__TAURI__; });

describe('Backup Settings, backup to another drive', () => {
  it('copy: names the feature and the paused state in plain words', () => {
    expect(en['premium.externalBackup.title']).toBe('Backup to another drive');
    expect(en['premium.externalBackup.blurb']).toBe('A second, independent copy of every email on an external drive or folder you choose, kept even after mail is deleted from the server.');
    expect(en['settings.backup.config.externalPausedFree']).toBe('Copies to this drive are paused because Premium is not active. What is already on the drive stays there, except mail you delete everywhere, which is removed from the drive when Premium resumes. Start Premium in Billing to resume; MailVault catches up on what it missed.');
    expect(en['errors.transportSwitchDrivePaused']).toBe('This account has a backup drive that is paused without Premium. Remove the drive in Settings, under Backup, or start Premium, then switch.');
    expect(en['settings.backup.verify.externalPaused']).toBe('External: paused (Premium)');
    expect(en['onboarding.storageBackupPremium']).toBe('Backup to another drive is part of Premium. You can turn it on later in Settings, under Backup.');
  });

  it('free, no drive: the picker is locked behind Premium with the price and an Upgrade button', () => {
    const onUpgrade = vi.fn();
    render(<BackupConfig onUpgrade={onUpgrade} />);
    expect(screen.queryByTestId('backup-picker')).toBeNull();
    const locked = screen.getByTestId('backup-drive-locked');
    expect(locked.textContent).toContain(t('common.premiumFeature'));
    expect(locked.textContent).toContain(t('premium.externalBackup.blurb'));
    expect(locked.textContent).toContain('PRICE-BLURB');
    fireEvent.click(screen.getByRole('button', { name: t('common.upgrade') }));
    expect(onUpgrade).toHaveBeenCalledOnce();
    // The free archive still works: scope and the mail folder stay.
    expect(screen.getByText(en['settings.backup.config.scopeLabel'])).toBeTruthy();
    expect(screen.getByTestId('mail-location')).toBeTruthy();
  });

  it('plan ended with a drive set: shows the drive as paused, not hidden, and lets the user remove it', async () => {
    useSettingsStore.setState({ billingProfile: LAPSED, externalBackupLocation: DRIVE });
    render(<BackupConfig onUpgrade={() => {}} />);
    expect(screen.queryByTestId('backup-picker')).toBeNull();
    const paused = screen.getByTestId('backup-drive-paused');
    expect(paused.textContent).toContain('/Volumes/Backup');
    expect(paused.textContent).toContain(t('settings.backup.config.externalPausedFree'));
    expect(screen.queryByText(t('settings.backup.config.secondCopyActivePlainEml'))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('settings.backup.config.removeExternalBackupLocation') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('backup_clear_external_location'));
    await waitFor(() => expect(useSettingsStore.getState().externalBackupLocation).toBe(null));
  });

  it('premium: the picker is there as before, with no lock or pause', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, externalBackupLocation: DRIVE });
    render(<BackupConfig onUpgrade={() => {}} />);
    expect(screen.getByTestId('backup-picker')).toBeTruthy();
    expect(screen.queryByTestId('backup-drive-locked')).toBeNull();
    expect(screen.queryByTestId('backup-drive-paused')).toBeNull();
    expect(screen.getByText(t('settings.backup.config.secondCopyActivePlainEml'))).toBeTruthy();
  });

  it('App Store build: the one-time purchase decides, never Premium', async () => {
    buildFlags.IS_APPSTORE_BUILD = true;
    invoke.mockImplementation(async (cmd) => (cmd === 'iap_is_entitled' ? true : undefined));
    render(<BackupConfig onUpgrade={() => {}} />);
    expect(await screen.findByTestId('backup-picker')).toBeTruthy();
    expect(screen.queryByTestId('backup-drive-locked')).toBeNull();
    expect(screen.queryByTestId('backup-drive-paused')).toBeNull();
  });

  it('App Store build without the purchase keeps its own paywall', async () => {
    buildFlags.IS_APPSTORE_BUILD = true;
    invoke.mockImplementation(async (cmd) => (cmd === 'iap_is_entitled' ? false : undefined));
    render(<BackupConfig onUpgrade={() => {}} />);
    expect(await screen.findByText(t('settings.backup.config.cloudBackupsOneTimePurchase'))).toBeTruthy();
    expect(screen.queryByTestId('backup-drive-locked')).toBeNull();
  });
});

describe('Backup verification, external counts', () => {
  const DATA = { total_server: 10, total_app: 10, total_external: 4, external_available: false, folders: [] };

  it('free with a drive set: External reads paused, not a failing percentage', () => {
    useSettingsStore.setState({ billingProfile: null, externalBackupLocation: DRIVE });
    render(<BackupVerificationTree data={DATA} onHide={() => {}} />);
    expect(screen.getByText(t('settings.backup.verify.externalPaused'))).toBeTruthy();
    expect(screen.queryByText(t('settings.backup.verify.externalPct', { pct: 40 }))).toBeNull();
  });

  it('premium: External shows its percentage as before', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, externalBackupLocation: DRIVE });
    render(<BackupVerificationTree data={DATA} onHide={() => {}} />);
    expect(screen.getByText(t('settings.backup.verify.externalPct', { pct: 40 }))).toBeTruthy();
    expect(screen.queryByText(t('settings.backup.verify.externalPaused'))).toBeNull();
  });
});
