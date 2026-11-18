// @vitest-environment jsdom
// Settings > Storage, its download card (the phone's offline window, settings/Storage.jsx): the
// window per account as desktop's "Keep mail from the last" choice, All mail behind Premium, the
// progress and the room the offline mail takes, a lapsed Premium's note, Low Data Mode, Download
// now, and "Download in the background".
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], state: null, settings: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.offline.get':
        return structuredClone(engine.state);
      case 'mobile.offline.set': {
        if (params.window === 'all' && !engine.state.premium) throw Object.assign(new Error('premium'), { code: 'PREMIUM_REQUIRED' });
        const entry = engine.state.accounts.find((a) => a.accountId === params.accountId);
        entry.window = params.window;
        entry.effectiveWindow = params.window;
        return { ...entry };
      }
      case 'mobile.offline.downloadNow':
        return { queued: true };
      case 'mobile.settings.get':
        return { ...engine.settings };
      case 'mobile.settings.set':
        Object.assign(engine.settings, params);
        return { ...engine.settings };
      case 'mobile.storage.get':
        return { accounts: [], databaseBytes: 0, searchBytes: 0, logsBytes: 0, cacheBytes: 0, totalBytes: 0 };
      case 'mobile.search.status':
        return { available: true, state: 'idle', indexed: 0, total: 0, sizeBytes: 0 };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: OfflineSettings, WINDOWS } = await import('../settings/Storage.jsx');
const { useMobileStore } = await import('../store.js');

const entry = (id, over = {}) => ({
  accountId: id, window: '3m', effectiveWindow: '3m', bodiesBytes: 2048, attachmentsBytes: 1024, messages: 40, offline: 12, foldersLeft: 0, ...over,
});

let paywall;
beforeEach(() => {
  engine.calls = [];
  engine.settings = { backgroundDownload: true };
  engine.state = { premium: false, network: { constrained: false, expensive: true }, accounts: [entry('a1'), entry('a2', { window: '12m', effectiveWindow: '12m' })] };
  paywall = vi.fn();
  useMobileStore.setState({
    accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada' }, { id: 'a2', email: 'grace@example.test', displayName: '' }],
    openPaywall: paywall,
  });
});
afterEach(cleanup);

const group = (name) => screen.getByRole('radiogroup', { name: t('mobile.offline.window', { account: name }) });
const option = (name, w) => within(group(name)).getAllByRole('radio')[WINDOWS.indexOf(w)];
const sets = () => engine.calls.filter(([m]) => m === 'mobile.offline.set').map(([, p]) => p);

describe('Settings > Storage > the offline window', () => {
  it('is desktop\'s keep-window choice, one per account', async () => {
    render(<OfflineSettings />);
    await waitFor(() => expect(option('Ada', '3m')).toBeTruthy());
    expect(screen.getByText(t('settings.storage.keepWindow'))).toBeTruthy();
    expect(within(group('Ada')).getAllByRole('radio').map((r) => r.textContent.replace(t('common.premium'), '')))
      .toEqual(['settings.storage.mo1', 'settings.storage.mo3', 'settings.storage.mo6', 'settings.storage.year1', 'settings.storage.keepAllMail'].map((k) => t(k)));
  });

  it('turns background downloads off and on', async () => {
    render(<OfflineSettings />);
    const toggle = await waitFor(() => {
      const el = screen.getByRole('switch', { name: t('mobile.settings.downloadToggle') });
      expect(el.getAttribute('aria-checked')).toBe('true');
      expect(el.disabled).toBe(false);
      return el;
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('switch', { name: t('mobile.settings.downloadToggle') }).getAttribute('aria-checked')).toBe('false'));
    expect(engine.calls.filter(([m]) => m === 'mobile.settings.set').map(([, p]) => p)).toEqual([{ backgroundDownload: false }]);
  });

  it('shows each account\'s window, progress and room, and changes the window', async () => {
    render(<OfflineSettings />);
    await waitFor(() => expect(option('Ada', '3m').getAttribute('aria-checked')).toBe('true'));
    expect(option('grace@example.test', '12m').getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByText(new RegExp(t('mobile.offline.progress', { offline: 12, total: 40 }))).length).toBe(2);
    fireEvent.click(option('Ada', '6m'));
    await waitFor(() => expect(option('Ada', '6m').getAttribute('aria-checked')).toBe('true'));
    expect(sets()).toEqual([{ accountId: 'a1', window: '6m' }]);
  });

  it('All mail without Premium opens the Premium screen and changes nothing', async () => {
    render(<OfflineSettings />);
    await waitFor(() => expect(option('Ada', 'all')).toBeTruthy());
    expect(option('Ada', 'all').textContent).toContain(t('common.premium'));
    fireEvent.click(option('Ada', 'all'));
    expect(paywall).toHaveBeenCalledWith(null);
    expect(sets()).toEqual([]);
  });

  it('with Premium, All mail is set; a lapse keeps it and says 3 months download', async () => {
    engine.state.premium = true;
    render(<OfflineSettings />);
    await waitFor(() => expect(option('Ada', 'all')).toBeTruthy());
    expect(option('Ada', 'all').textContent).not.toContain(t('common.premium'));
    fireEvent.click(option('Ada', 'all'));
    await waitFor(() => expect(option('Ada', 'all').getAttribute('aria-checked')).toBe('true'));
    cleanup();
    engine.state.premium = false;
    engine.state.accounts[0].effectiveWindow = '3m';
    render(<OfflineSettings />);
    await waitFor(() => expect(screen.getByText(t('mobile.offline.allNeedsPremium'))).toBeTruthy());
    expect(option('Ada', 'all').getAttribute('aria-checked')).toBe('true');
  });

  // An import from the computer can store All mail on a phone that never had Premium: the note
  // must not speak of a Premium that ended.
  it('All mail stored without Premium (never had it) shows a neutral note', async () => {
    engine.state.accounts[0] = entry('a1', { window: 'all', effectiveWindow: '3m' });
    render(<OfflineSettings />);
    const note = await waitFor(() => {
      const el = document.querySelector('[data-mv-offline-account="a1"] [data-mv-offline-lapsed]');
      expect(el).toBeTruthy();
      return el;
    });
    expect(note.textContent).toBe(t('mobile.offline.allNeedsPremium'));
    expect(note.textContent).not.toMatch(/ended/i);
  });

  it('says when Low Data Mode holds downloads, and Download now asks the engine', async () => {
    engine.state.network.constrained = true;
    render(<OfflineSettings />);
    await waitFor(() => expect(screen.getByText(t('mobile.offline.lowData'))).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: t('mobile.offline.downloadNow') })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('mobile.offline.downloadNow') }));
    await waitFor(() => expect(screen.getByText(t('mobile.offline.downloading'))).toBeTruthy());
    expect(engine.calls.some(([m]) => m === 'mobile.offline.downloadNow')).toBe(true);
  });
});
