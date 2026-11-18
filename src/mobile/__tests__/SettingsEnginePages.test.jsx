// @vitest-environment jsdom
// Settings pages backed by the engine, drawn with desktop's views: Unfinished server actions (retry,
// cancel one), Storage (the room in all, per account and per file), Logs (detail, view, copy, clear
// after a confirm) and Data usage (totals by period, today against the limits, the switches and the
// limits, unmeasured accounts), plus the warning notice the store raises from the engine's event.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], pending: [], usage: null, logs: '', listeners: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.actions.pending':
        return { pending: structuredClone(engine.pending) };
      case 'mobile.actions.retry':
        return { queued: true };
      case 'mobile.actions.discard': {
        const before = engine.pending.length;
        engine.pending = engine.pending.filter((p) => p.seq !== params.seq);
        return { discarded: engine.pending.length < before };
      }
      case 'mobile.storage.get':
        return {
          accounts: [{ accountId: 'a1', messages: 12, bodiesBytes: 3 * 1024 * 1024, attachmentsBytes: 1024 * 1024 }],
          databaseBytes: 8 * 1024 * 1024, searchBytes: 2 * 1024 * 1024, logsBytes: 4096, cacheBytes: 1024 * 1024, totalBytes: 15 * 1024 * 1024,
        };
      case 'mobile.logs.get':
        return { text: engine.logs, bytes: engine.logs.length };
      case 'mobile.logs.clear':
        engine.logs = '';
        return {};
      case 'mobile.prefs.set':
        return { ...params };
      case 'mobile.settings.get':
        return { backgroundDownload: true };
      case 'mobile.offline.get':
        return { premium: false, network: {}, accounts: [] };
      case 'mobile.search.status':
        return { available: true, state: 'idle', indexed: 0, total: 0, sizeBytes: 0 };
      case 'mobile.dataUsage.get':
        return structuredClone(engine.usage);
      case 'mobile.dataUsage.set': {
        const entry = engine.usage.accounts.find((a) => a.accountId === params.accountId);
        if ('capEnabled' in params) entry.limits.capEnabled = params.capEnabled;
        if ('warnEnabled' in params) entry.limits.warnEnabled = params.warnEnabled;
        if ('dailyDownLimitBytes' in params) {
          entry.typed.dailyDownLimitBytes = params.dailyDownLimitBytes;
          entry.limits.down.limitBytes = params.dailyDownLimitBytes;
        }
        return structuredClone(entry);
      }
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    (engine.listeners[name] ||= []).push(handler);
    return () => { engine.listeners[name] = engine.listeners[name].filter((h) => h !== handler); };
  }),
}));

const { PendingActions, Logs: LogsSettings } = await import('../settings/Diagnostics.jsx');
const { default: StorageSettings } = await import('../settings/Storage.jsx');
const { default: DataUsage } = await import('../settings/DataUsage.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const MB = 1024 * 1024;
const NO_LIMIT = { limitBytes: null, isProviderDefault: false, defaultCapOn: null, defaultCapOff: null };
const usageEntry = (id, over = {}) => ({
  accountId: id,
  measured: true,
  today: { down: 90 * MB, up: 1 * MB },
  week: { down: 300 * MB, up: 5 * MB },
  month: { down: 900 * MB, up: 9 * MB },
  year: { down: 2000 * MB, up: 20 * MB },
  limits: { gmail: false, capEnabled: false, warnEnabled: true, down: { ...NO_LIMIT, limitBytes: 100 * MB }, up: { ...NO_LIMIT } },
  typed: { dailyDownLimitBytes: 100 * MB, dailyUpLimitBytes: null },
  paused: false,
  warning: null,
  ...over,
});

const calls = (m) => engine.calls.filter(([x]) => x === m).map(([, p]) => p);

beforeEach(() => {
  engine.calls = [];
  engine.listeners = {};
  engine.pending = [
    { seq: 7, accountId: 'a1', folder: 'INBOX', kind: 'delete', uids: [3, 4], state: 'retrying', lastError: 'HOST_UNREACHABLE', attempts: 2, createdMs: Date.UTC(2026, 10, 1, 9) },
    { seq: 8, accountId: 'a1', folder: 'Archive', kind: 'seen', uids: [5], state: 'queued', lastError: null, attempts: 0, createdMs: Date.UTC(2026, 10, 1, 10) },
  ];
  engine.logs = '2026-11-15T10:00:00.000Z [sync] a1 done\n2026-11-15T10:00:01.000Z [sync] a2 done';
  engine.usage = { accounts: [usageEntry('a1'), usageEntry('a2', { measured: false })] };
  useMobileStore.setState({
    accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada' }, { id: 'a2', email: 'grace@example.test', displayName: '' }],
    prefs: { ...PREF_DEFAULTS },
  });
});
afterEach(cleanup);

const items = () => screen.queryAllByRole('listitem');
const cancelOf = (label) => screen.getByRole('button', { name: `${t('common.cancel')}: ${t(label)}` });

describe('Settings > Unfinished server actions', () => {
  it('lists what the server still owes, with why and how often it was tried', async () => {
    render(<PendingActions />);
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(screen.getByText(t('settings.pendingActions.title'))).toBeTruthy();
    const [first, second] = items();
    expect(first.textContent).toContain(t('settings.pendingActions.opDelete'));
    expect(first.textContent).toContain('ada@example.test');
    expect(first.textContent).toContain(t('common.messageCount', { count: 2 }));
    expect(first.textContent).toContain(t('settings.pendingActions.attempts', { count: 2 }));
    expect(first.textContent).toContain(t('mobile.error.HOST_UNREACHABLE'));
    expect(second.textContent).toContain(t('settings.pendingActions.opFlag'));
    expect(second.textContent).toContain(t('settings.pendingActions.notTriedYet'));
    expect(calls('mobile.actions.pending')[0]).toEqual({});
  });

  it('Cancel gives one up; Retry now asks for every account; an empty journal says so', async () => {
    render(<PendingActions />);
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(cancelOf('settings.pendingActions.opDelete'));
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(calls('mobile.actions.discard')).toEqual([{ seq: 7 }]);
    fireEvent.click(screen.getByRole('button', { name: t('settings.pendingActions.retryNow') }));
    await waitFor(() => expect(calls('mobile.actions.retry')).toEqual([{}]));
    engine.pending = [];
    act(() => engine.listeners['mobile.action.result'].forEach((h) => h({ seq: 8, outcome: 'done' })));
    expect(await screen.findByText(t('settings.pendingActions.empty'))).toBeTruthy();
    expect(items()).toHaveLength(0);
  });
});

describe('Settings > Storage', () => {
  it('shows the total, each account and each file', async () => {
    render(<StorageSettings />);
    await waitFor(() => expect(document.querySelector('[data-mv-storage="account:a1"]')).toBeTruthy());
    const total = screen.getByText(t('settings.storage.localStorageUsage')).parentElement;
    expect(total.textContent).toContain('15');
    expect(total.textContent).toContain(t('settings.storage.emailsSavedParen', { count: 12 }));
    const acct = document.querySelector('[data-mv-storage="account:a1"]');
    expect(acct.textContent).toContain('Ada');
    expect(acct.textContent).toContain(t('common.messageCount', { count: 12 }));
    expect(acct.textContent).toContain('4');
    for (const name of ['database', 'search', 'logs', 'cache']) expect(document.querySelector(`[data-mv-storage="${name}"]`)).toBeTruthy();
    // Desktop's Storage Status card, without desktop's "ordinary files on this disk" line.
    expect(screen.getByText(t('settings.storage.storageStatus'))).toBeTruthy();
    expect(screen.queryByText(t('settings.storage.ordinaryFilesNothingUploaded'))).toBeNull();
  });
});

describe('Settings > Logs', () => {
  it('shows the log, copies it, and clears it only after a confirm', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<LogsSettings />);
    await waitFor(() => expect(screen.getByText(/\[sync\] a2 done/)).toBeTruthy());
    expect(calls('mobile.logs.get')[0]).toEqual({ lines: 500 });
    fireEvent.click(screen.getByRole('button', { name: t('viewer.copy') }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(engine.logs));
    expect(await screen.findByText(t('settings.logs.copied'))).toBeTruthy();

    const clear = () => screen.getByRole('button', { name: t('settings.logs.clearLog2') });
    fireEvent.click(clear());
    expect(calls('mobile.logs.clear')).toEqual([]);
    const confirm = document.querySelector('[data-mv-logs-confirm]');
    fireEvent.click(screen.getByRole('button', { name: t('settings.logs.keep') }));
    expect(document.querySelector('[data-mv-logs-confirm]')).toBeNull();
    expect(confirm).toBeTruthy();
    fireEvent.click(clear());
    fireEvent.click(within(document.querySelector('[data-mv-logs-confirm]')).getByRole('button', { name: t('settings.logs.clearLog2') }));
    await waitFor(() => expect(calls('mobile.logs.clear')).toEqual([{}]));
    expect(await screen.findByText(t('mobile.logs.empty'))).toBeTruthy();
  });

  it('log detail is the logVerbosity preference', async () => {
    const setPrefs = vi.fn(async () => true);
    useMobileStore.setState({ setPrefs });
    render(<LogsSettings />);
    const group = screen.getByRole('radiogroup', { name: t('settings.logs.verbosityTitle') });
    const [standard, verbose] = within(group).getAllByRole('radio');
    expect(standard.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(verbose);
    await waitFor(() => expect(setPrefs).toHaveBeenCalledWith({ logVerbosity: 'verbose' }));
  });
});

const card = (id) => document.querySelector(`[data-mv-usage-account="${id}"]`);
const field = (id, key) => within(card(id)).getByLabelText(t(key));
const toggleOf = (id, key) => within(card(id)).getByRole('switch', { name: t(key) });

describe('Settings > Data usage', () => {
  it('shows the period totals and today against the limit; an account not measured says so', async () => {
    render(<DataUsage />);
    await waitFor(() => expect(card('a1')).toBeTruthy());
    const a1 = card('a1');
    expect(a1.textContent).toContain('90');
    fireEvent.click(within(a1).getByRole('button', { name: t('settings.dataUsage.period.month') }));
    expect(a1.textContent).toContain('900');
    // Today's download against its 100 MB limit: 90%, past the 80% warning mark.
    const bar = within(a1).getByText(t('settings.dataUsage.account.download')).parentElement.nextElementSibling.firstElementChild;
    expect(bar.style.width).toBe('90%');
    expect(bar.className).toContain('bg-mail-warning');
    const a2 = card('a2');
    expect(within(a2).getByText(t('settings.dataUsage.unavailable'))).toBeTruthy();
    expect(within(a2).queryByText(t('settings.dataUsage.account.downloaded'))).toBeNull();
  });

  it('the switches and the limits write the engine, in bytes', async () => {
    render(<DataUsage />);
    await waitFor(() => expect(card('a1')).toBeTruthy());
    const cap = () => toggleOf('a1', 'settings.dataUsage.account.pauseBackgroundDownloads');
    expect(cap().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(cap());
    await waitFor(() => expect(cap().getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggleOf('a1', 'settings.dataUsage.account.warnWhenNearingDailyLimit'));
    const down = field('a1', 'settings.dataUsage.account.dailyDownloadLimitMb');
    expect(down.value).toBe('100');
    fireEvent.change(down, { target: { value: '250' } });
    fireEvent.blur(down);
    const up = field('a1', 'settings.dataUsage.account.dailyUploadLimitMb');
    expect(up.placeholder).toBe(t('settings.dataUsage.account.unlimited'));
    fireEvent.change(up, { target: { value: '-3' } });
    fireEvent.blur(up);
    await waitFor(() => expect(calls('mobile.dataUsage.set')).toHaveLength(3));
    expect(calls('mobile.dataUsage.set')).toEqual([
      { accountId: 'a1', capEnabled: true },
      { accountId: 'a1', warnEnabled: false },
      { accountId: 'a1', dailyDownLimitBytes: 250 * MB },
    ]);
  });

  it('a limit under a whole MB shows as typed, and a blur with no change writes nothing', async () => {
    engine.usage = { accounts: [usageEntry('a1', { typed: { dailyDownLimitBytes: 0.5 * MB, dailyUpLimitBytes: 1.234567 * MB } })] };
    render(<DataUsage />);
    await waitFor(() => expect(card('a1')).toBeTruthy());
    const down = field('a1', 'settings.dataUsage.account.dailyDownloadLimitMb');
    const up = field('a1', 'settings.dataUsage.account.dailyUploadLimitMb');
    expect(down.value).toBe('0.5');
    expect(up.value).toBe('1.23');
    fireEvent.blur(down);
    fireEvent.blur(up);
    await act(async () => {});
    expect(calls('mobile.dataUsage.set')).toEqual([]);
    fireEvent.change(down, { target: { value: '0.25' } });
    fireEvent.blur(down);
    await waitFor(() => expect(calls('mobile.dataUsage.set')).toEqual([{ accountId: 'a1', dailyDownLimitBytes: Math.round(0.25 * MB) }]));
  });

  it('a paused account says so', async () => {
    engine.usage = { accounts: [usageEntry('a1', { paused: true })] };
    render(<DataUsage />);
    expect(await screen.findByText(t('mobile.dataUsage.paused'))).toBeTruthy();
  });
});

describe('the data usage warning', () => {
  it('the engine\'s warning becomes a notice naming the account and the share', async () => {
    // The store subscribes when it starts (`init`); this engine has no accounts list, so the start
    // fails after subscribing, which is all this needs.
    const started = useMobileStore.getState().init({ sync: false }).catch(() => {});
    const handlers = [...(engine.listeners['mobile.usage.warning'] || [])];
    expect(handlers).toHaveLength(1);
    act(() => handlers[0]({ accountId: 'a1', direction: 'download', percent: 85 }));
    const notice = useMobileStore.getState().notice;
    expect(notice.key).toBe('transferLimit.usedOfDailyDownload');
    expect(notice.params).toEqual({ email: 'ada@example.test', pct: 85 });
    expect(t(notice.key, notice.params)).toBe('ada@example.test has used 85% of its daily download limit');
    // A direction the page does not know raises nothing.
    act(() => handlers[0]({ accountId: 'a1', direction: 'sideways', percent: 85 }));
    expect(useMobileStore.getState().notice).toBe(notice);
    await started;
  });
});
