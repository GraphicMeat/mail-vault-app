// @vitest-environment jsdom
// Download modes (Track H, H5): the picker Settings > Storage and onboarding
// share, and its per-account form in Settings > Accounts.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn(async () => ({ ok: true })) }));

import { DownloadModeControl } from '../DownloadModeControl';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const radio = (name) => screen.getByRole('radio', { name });
const hoarder = () => radio(new RegExp(t('settings.storage.modeHoarder')));

beforeEach(() => {
  useSettingsStore.setState({
    billingProfile: null, shareGrant: null,
    fetchMode: 'keepRecent', fetchModes: {}, localCacheDurationMonths: 3,
  });
});
afterEach(cleanup);

describe('DownloadModeControl', () => {
  it('offers the four modes with Keep Recent chosen by default', () => {
    render(<DownloadModeControl />);
    for (const key of ['modeOnDemand', 'modeKeepRecent', 'modeIndexOnly']) {
      expect(radio(t(`settings.storage.${key}`))).toBeTruthy();
    }
    expect(hoarder()).toBeTruthy();
    expect(radio(t('settings.storage.modeKeepRecent')).getAttribute('aria-checked')).toBe('true');
  });

  it('says backups and archived mail are never removed', () => {
    render(<DownloadModeControl />);
    expect(screen.getByText(t('settings.storage.modeNeverRemoves'))).toBeTruthy();
  });

  it('On Demand says full-text search covers only mail kept on this computer', () => {
    useSettingsStore.setState({ fetchMode: 'onDemand' });
    render(<DownloadModeControl />);
    expect(screen.getByText(t('settings.storage.modeHintOnDemand'))).toBeTruthy();
    expect(t('settings.storage.modeHintOnDemand')).toMatch(/full-text search covers only mail kept on this computer/i);
  });

  it('shows the 1/3/6/12 month window for Keep Recent and Index Only, not for the others', () => {
    const { rerender } = render(<DownloadModeControl />);
    const windowPicker = () => screen.queryByRole('radiogroup', { name: t('settings.storage.keepWindow') });
    expect(windowPicker()).toBeTruthy();
    fireEvent.click(radio(t('settings.storage.year1')));
    expect(useSettingsStore.getState().localCacheDurationMonths).toBe(12);

    fireEvent.click(radio(t('settings.storage.modeIndexOnly')));
    rerender(<DownloadModeControl />);
    expect(windowPicker()).toBeTruthy();

    fireEvent.click(radio(t('settings.storage.modeOnDemand')));
    rerender(<DownloadModeControl />);
    expect(windowPicker()).toBeNull();
  });

  it('marks Hoarder as Premium and, without Premium, offers the upgrade and keeps the mode', () => {
    const onUpgrade = vi.fn();
    render(<DownloadModeControl onUpgrade={onUpgrade} />);
    expect(hoarder().textContent).toContain(t('common.premium'));

    fireEvent.click(hoarder());
    expect(useSettingsStore.getState().fetchMode).toBe('keepRecent');
    fireEvent.click(screen.getByTestId('download-mode-upgrade'));
    expect(onUpgrade).toHaveBeenCalledOnce();
  });

  it('lets Premium choose Hoarder', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM });
    render(<DownloadModeControl />);
    fireEvent.click(hoarder());
    expect(useSettingsStore.getState().fetchMode).toBe('hoarder');
    expect(screen.queryByTestId('download-mode-no-premium')).toBeNull();
  });

  it('keeps an already-migrated Hoarder selected without Premium, and says what that means', () => {
    useSettingsStore.setState({ fetchMode: 'hoarder', localCacheDurationMonths: 12 });
    render(<DownloadModeControl />);
    expect(hoarder().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('download-mode-no-premium').textContent)
      .toBe(t('settings.storage.hoarderWithoutPremium'));
    expect(useSettingsStore.getState().fetchMode).toBe('hoarder');
  });
});

describe('DownloadModeControl edge cases (fix round 1)', () => {
  it('shows a saved Keep Recent window of 0 as its own checked, focusable choice', () => {
    useSettingsStore.setState({ fetchMode: 'keepRecent', localCacheDurationMonths: 0 });
    render(<DownloadModeControl />);
    const all = radio(t('settings.storage.keepAllMail'));
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(all.tabIndex).toBe(0);
    fireEvent.click(radio(t('settings.storage.mo6')));
    expect(useSettingsStore.getState().localCacheDurationMonths).toBe(6);
  });

  it('offers no "All mail" choice for an ordinary window', () => {
    render(<DownloadModeControl />);
    expect(screen.queryByRole('radio', { name: t('settings.storage.keepAllMail') })).toBeNull();
  });

  it('warns a free Hoarder that leaving is one way, and says nothing to Premium', () => {
    useSettingsStore.setState({ fetchMode: 'hoarder' });
    const { rerender } = render(<DownloadModeControl />);
    expect(screen.getByTestId('download-mode-hoarder-one-way').textContent).toBe(t('settings.storage.hoarderOneWay'));

    useSettingsStore.setState({ billingProfile: PREMIUM });
    rerender(<DownloadModeControl />);
    expect(screen.queryByTestId('download-mode-hoarder-one-way')).toBeNull();
  });

  it('Keep Recent copy says older copies may be removed, not that they are', () => {
    expect(t('settings.storage.modeHintKeepRecent')).toMatch(/may be removed/);
  });
});

describe('DownloadModeControl for one account', () => {
  it('starts on "Use default", persists an override, and goes back to the default', () => {
    render(<DownloadModeControl accountId="acct1" />);
    const useDefault = radio(t('settings.storage.useDefaultMode', { mode: t('settings.storage.modeKeepRecent') }));
    expect(useDefault.getAttribute('aria-checked')).toBe('true');
    // The window is global: it lives with the default, not the account.
    expect(screen.queryByRole('radiogroup', { name: t('settings.storage.keepWindow') })).toBeNull();

    fireEvent.click(radio(t('settings.storage.modeOnDemand')));
    expect(useSettingsStore.getState().fetchModes).toEqual({ acct1: 'onDemand' });
    expect(useSettingsStore.getState().fetchMode).toBe('keepRecent');

    fireEvent.click(useDefault);
    expect(useSettingsStore.getState().fetchModes).toEqual({});
  });
});
