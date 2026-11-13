// @vitest-environment jsdom
// Settings > Offline: the window per account, All mail behind Premium, the progress and the room
// the offline mail takes, a lapsed Premium's note, Low Data Mode, and Download now.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], state: null }));

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
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: OfflineSettings } = await import('../OfflineSettings.jsx');
const { useMobileStore } = await import('../store.js');

const entry = (id, over = {}) => ({
  accountId: id, window: '3m', effectiveWindow: '3m', bodiesBytes: 2048, attachmentsBytes: 1024, messages: 40, offline: 12, foldersLeft: 0, ...over,
});

let paywall;
beforeEach(() => {
  engine.calls = [];
  engine.state = { premium: false, network: { constrained: false, expensive: true }, accounts: [entry('a1'), entry('a2', { window: '12m', effectiveWindow: '12m' })] };
  paywall = vi.fn();
  useMobileStore.setState({
    accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada' }, { id: 'a2', email: 'grace@example.test', displayName: '' }],
    openPaywall: paywall,
  });
});
afterEach(cleanup);

const group = (name) => screen.getByRole('radiogroup', { name: t('mobile.offline.window', { account: name }) });
const option = (name, w) => group(name).querySelector(`[data-mv-window="${w}"]`);
const sets = () => engine.calls.filter(([m]) => m === 'mobile.offline.set').map(([, p]) => p);

describe('Settings > Offline', () => {
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
    await waitFor(() => expect(screen.getByText(t('mobile.offline.lapsed'))).toBeTruthy());
    expect(option('Ada', 'all').getAttribute('aria-checked')).toBe('true');
  });

  it('says when Low Data Mode holds downloads, and Download now asks the engine', async () => {
    engine.state.network.constrained = true;
    render(<OfflineSettings />);
    await waitFor(() => expect(screen.getByText(t('mobile.offline.lowData'))).toBeTruthy());
    fireEvent.click(screen.getByText(t('mobile.offline.downloadNow')));
    await waitFor(() => expect(screen.getByText(t('mobile.offline.downloading'))).toBeTruthy());
    expect(engine.calls.some(([m]) => m === 'mobile.offline.downloadNow')).toBe(true);
  });
});
