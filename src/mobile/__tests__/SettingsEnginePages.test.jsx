// @vitest-environment jsdom
// Settings pages backed by the engine: Unfinished server actions (retry, cancel one), Storage (the
// room per account and per file, a link to Offline), Logs (detail, view, copy, clear after a
// confirm) and Data usage (totals by period, today against the limits, the switches and the
// limits, unmeasured accounts), plus the warning notice the store raises from the engine's event.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
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

const { default: PendingActions } = await import('../PendingActions.jsx');
const { default: StorageSettings } = await import('../StorageSettings.jsx');
const { default: LogsSettings } = await import('../LogsSettings.jsx');
const { default: DataUsage } = await import('../DataUsage.jsx');
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

describe('Settings > Unfinished server actions', () => {
  it('lists what the server still owes, with why and how often it was tried', async () => {
    render(<PendingActions />);
    await waitFor(() => expect(document.querySelectorAll('[data-mv-pending-action]')).toHaveLength(2));
    const first = document.querySelector('[data-mv-pending-action="7"]');
    expect(first.textContent).toContain(t('settings.pendingActions.opDelete'));
    expect(first.textContent).toContain('ada@example.test');
    expect(first.textContent).toContain(t('common.messageCount', { count: 2 }));
    expect(first.textContent).toContain(t('settings.pendingActions.attempts', { count: 2 }));
    expect(first.textContent).toContain(t('mobile.error.HOST_UNREACHABLE'));
    const second = document.querySelector('[data-mv-pending-action="8"]');
    expect(second.textContent).toContain(t('settings.pendingActions.opFlag'));
    expect(second.textContent).toContain(t('settings.pendingActions.notTriedYet'));
    expect(calls('mobile.actions.pending')[0]).toEqual({});
  });

  it('Cancel gives one up; Retry now asks for every account; an empty journal says so', async () => {
    render(<PendingActions />);
    await waitFor(() => expect(document.querySelector('[data-mv-pending-action="7"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-mv-pending-action="7"] button'));
    await waitFor(() => expect(document.querySelector('[data-mv-pending-action="7"]')).toBeNull());
    expect(calls('mobile.actions.discard')).toEqual([{ seq: 7 }]);
    fireEvent.click(document.querySelector('[data-mv-pending-retry]'));
    await waitFor(() => expect(calls('mobile.actions.retry')).toEqual([{}]));
    engine.pending = [];
    act(() => engine.listeners['mobile.action.result'].forEach((h) => h({ seq: 8, outcome: 'done' })));
    await waitFor(() => expect(document.querySelector('[data-mv-pending-empty]')).toBeTruthy());
    expect(screen.getByText(t('settings.pendingActions.empty'))).toBeTruthy();
  });
});

describe('Settings > Storage', () => {
  it('shows the total, each account and each file, and opens Offline', async () => {
    const onOpenOffline = vi.fn();
    render(<StorageSettings onOpenOffline={onOpenOffline} />);
    await waitFor(() => expect(document.querySelector('[data-mv-storage="total"]')).toBeTruthy());
    expect(document.querySelector('[data-mv-storage="total"]').textContent).toContain('15');
    const acct = document.querySelector('[data-mv-storage="account:a1"]');
    expect(acct.textContent).toContain('Ada');
    expect(acct.textContent).toContain(t('common.messageCount', { count: 12 }));
    expect(acct.textContent).toContain('4');
    for (const name of ['database', 'search', 'logs', 'cache']) expect(document.querySelector(`[data-mv-storage="${name}"]`)).toBeTruthy();
    fireEvent.click(document.querySelector('[data-mv-storage-offline]'));
    expect(onOpenOffline).toHaveBeenCalledTimes(1);
  });
});

describe('Settings > Logs', () => {
  it('shows the log, copies it, and clears it only after a confirm', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<LogsSettings />);
    await waitFor(() => expect(document.querySelector('[data-mv-logs-text]').textContent).toContain('[sync] a2 done'));
    expect(calls('mobile.logs.get')[0]).toEqual({ lines: 500 });
    fireEvent.click(document.querySelector('[data-mv-logs-copy]'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(engine.logs));
    expect(await screen.findByText(t('settings.logs.copied'))).toBeTruthy();

    fireEvent.click(document.querySelector('[data-mv-logs-clear]'));
    expect(calls('mobile.logs.clear')).toEqual([]);
    const confirm = document.querySelector('[data-mv-logs-confirm]');
    fireEvent.click(screen.getByRole('button', { name: t('settings.logs.keep') }));
    expect(document.querySelector('[data-mv-logs-confirm]')).toBeNull();
    expect(confirm).toBeTruthy();
    fireEvent.click(document.querySelector('[data-mv-logs-clear]'));
    fireEvent.click(document.querySelector('[data-mv-logs-confirm] .mv-textbtn--danger'));
    await waitFor(() => expect(calls('mobile.logs.clear')).toEqual([{}]));
    await waitFor(() => expect(document.querySelector('[data-mv-logs-text]').textContent).toBe(t('mobile.logs.empty')));
  });

  it('log detail is the logVerbosity preference', async () => {
    const setPrefs = vi.fn(async () => true);
    useMobileStore.setState({ setPrefs });
    render(<LogsSettings />);
    const select = document.querySelector('[data-mv-pref="logVerbosity"]');
    expect(select.value).toBe('standard');
    fireEvent.change(select, { target: { value: 'verbose' } });
    await waitFor(() => expect(setPrefs).toHaveBeenCalledWith({ logVerbosity: 'verbose' }));
  });
});

describe('Settings > Data usage', () => {
  it('shows the period totals and today against the limit; an account not measured says so', async () => {
    render(<DataUsage />);
    await waitFor(() => expect(document.querySelector('[data-mv-usage-account="a1"]')).toBeTruthy());
    const a1 = document.querySelector('[data-mv-usage-account="a1"]');
    expect(a1.querySelector('[data-mv-usage-totals]').textContent).toContain('90');
    fireEvent.click(a1.querySelector('[data-mv-usage-period="month"]'));
    expect(a1.querySelector('[data-mv-usage-totals]').textContent).toContain('900');
    const bar = a1.querySelector('progress');
    expect(Number(bar.getAttribute('value'))).toBeCloseTo(0.9);
    expect(bar.className).toContain('mv-usage__meter--warn');
    const a2 = document.querySelector('[data-mv-usage-account="a2"]');
    expect(a2.querySelector('[data-mv-usage-unmeasured]').textContent).toBe(t('settings.dataUsage.unavailable'));
    expect(a2.querySelector('[data-mv-usage-totals]')).toBeNull();
  });

  it('the switches and the limits write the engine, in bytes', async () => {
    render(<DataUsage />);
    await waitFor(() => expect(document.querySelector('[data-mv-usage-account="a1"]')).toBeTruthy());
    const a1 = () => document.querySelector('[data-mv-usage-account="a1"]');
    const cap = a1().querySelector('[data-mv-usage-toggle="cap"]');
    expect(cap.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(cap);
    await waitFor(() => expect(a1().querySelector('[data-mv-usage-toggle="cap"]').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(a1().querySelector('[data-mv-usage-toggle="warn"]'));
    const down = a1().querySelector('[data-mv-usage-limit="down"]');
    expect(down.value).toBe('100');
    fireEvent.change(down, { target: { value: '250' } });
    fireEvent.blur(down);
    const up = a1().querySelector('[data-mv-usage-limit="up"]');
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
