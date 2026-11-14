// @vitest-environment jsdom
// Settings > Notifications, desktop's per-account folders and quiet hours and its priority
// senders (NotifySettings.jsx): each saved in the engine, which the background run reads.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], settings: null, accounts: {}, prefs: {}, folders: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.settings.get':
        return { ...engine.settings };
      case 'mobile.settings.set':
        engine.settings = { ...engine.settings, ...params };
        return { ...engine.settings };
      case 'mobile.accountSettings.get':
        return { accountId: params.accountId, notify: true, notifyFolders: ['INBOX'], quietHours: null, ...engine.accounts[params.accountId] };
      case 'mobile.accountSettings.set':
        engine.accounts[params.accountId] = { ...engine.accounts[params.accountId], ...params.values };
        return { accountId: params.accountId, notify: true, notifyFolders: ['INBOX'], quietHours: null, ...engine.accounts[params.accountId] };
      case 'mobile.folders.list':
        return { folders: engine.folders[params.accountId] || [] };
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.prefs.set':
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
  notificationPermission: vi.fn(async () => ({ granted: true })),
}));

const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');

const A1 = { id: 'a1', email: 'ada@example.test', displayName: 'Ada', needsAuth: false };
const folder = (path, extra = {}) => ({ path, name: path, specialUse: null, depth: 0, noselect: false, unseen: 0, total: 0, ...extra });

beforeEach(() => {
  engine.calls = [];
  engine.settings = { notifications: 'on', notificationPreview: true };
  engine.accounts = {};
  engine.prefs = { importantSenders: [] };
  engine.folders = { a1: [folder('INBOX', { specialUse: '\\Inbox' }), folder('Work'), folder('[Gmail]', { noselect: true })] };
  useMobileStore.setState({ accounts: [A1], activeAccountId: 'a1', reauthState: null });
});
afterEach(cleanup);

const accountSets = () => engine.calls.filter(([m]) => m === 'mobile.accountSettings.set').map(([, p]) => p.values);
const prefSets = () => engine.calls.filter(([m]) => m === 'mobile.prefs.set').map(([, p]) => p);

/** Opens the account's folders and quiet hours. */
async function openAccount() {
  const more = await waitFor(() => {
    const b = screen.getByRole('button', { name: `${t('settings.notifications.configureFolders')}: ${A1.email}` });
    expect(b.disabled).toBe(false);
    return b;
  });
  fireEvent.click(more);
  return screen.getByRole('group', { name: `${t('settings.notifications.configureFolders')}: ${A1.email}` });
}

describe('Notification settings', () => {
  it('quiet hours: the switch saves desktop\'s default window, and each time saves the whole window', async () => {
    render(<Settings page="notifications" onClose={() => {}} />);
    const box = await openAccount();
    const quiet = within(box).getByRole('switch', { name: t('notifyPolicy.quietHours.title') });
    expect(quiet.getAttribute('aria-checked')).toBe('false');
    expect(within(box).queryByLabelText(`${t('notifyPolicy.quietHours.title')}: ${t('common.from')}`)).toBeNull();
    fireEvent.click(quiet);
    await waitFor(() => expect(quiet.getAttribute('aria-checked')).toBe('true'));
    expect(accountSets()).toEqual([{ quietHours: { enabled: true, start: '22:00', end: '07:00' } }]);

    const from = within(box).getByLabelText(`${t('notifyPolicy.quietHours.title')}: ${t('common.from')}`);
    expect(from.value).toBe('22:00');
    fireEvent.change(from, { target: { value: '23:30' } });
    await waitFor(() => expect(accountSets()).toHaveLength(2));
    expect(accountSets()[1]).toEqual({ quietHours: { enabled: true, start: '23:30', end: '07:00' } });
    const to = within(box).getByLabelText(`${t('notifyPolicy.quietHours.title')}: ${t('common.to')}`);
    fireEvent.change(to, { target: { value: '06:15' } });
    await waitFor(() => expect(accountSets()).toHaveLength(3));
    expect(accountSets()[2]).toEqual({ quietHours: { enabled: true, start: '23:30', end: '06:15' } });
    // A cleared field saves nothing.
    fireEvent.change(to, { target: { value: '' } });
    expect(accountSets()).toHaveLength(3);
  });

  it('shows a stored window and turns it off keeping its times', async () => {
    engine.accounts.a1 = { quietHours: { enabled: true, start: '21:00', end: '06:00' } };
    render(<Settings page="notifications" onClose={() => {}} />);
    const box = await openAccount();
    const from = within(box).getByLabelText(`${t('notifyPolicy.quietHours.title')}: ${t('common.from')}`);
    expect(from.value).toBe('21:00');
    fireEvent.click(within(box).getByRole('switch', { name: t('notifyPolicy.quietHours.title') }));
    await waitFor(() => expect(accountSets()).toEqual([{ quietHours: { enabled: false, start: '21:00', end: '06:00' } }]));
  });

  it('notify folders: the account\'s real folders, ticked from the stored list, a stored one not listed kept', async () => {
    engine.accounts.a1 = { notifyFolders: ['INBOX', 'Old/Projects'] };
    render(<Settings page="notifications" onClose={() => {}} />);
    const box = await openAccount();
    const box1 = await waitFor(() => {
      expect(within(box).getByRole('checkbox', { name: 'Work' })).toBeTruthy();
      return box;
    });
    const inbox = within(box1).getByRole('checkbox', { name: t('sidebar.inbox') });
    const workBox = within(box1).getByRole('checkbox', { name: 'Work' });
    const old = within(box1).getByRole('checkbox', { name: 'Old/Projects' });
    expect([inbox.checked, workBox.checked, old.checked]).toEqual([true, false, true]);
    expect(within(box1).queryByRole('checkbox', { name: '[Gmail]' })).toBeNull();

    fireEvent.click(workBox);
    await waitFor(() => expect(accountSets()).toEqual([{ notifyFolders: ['INBOX', 'Old/Projects', 'Work'] }]));
    await waitFor(() => expect(within(box1).getByRole('checkbox', { name: 'Work' }).checked).toBe(true));
    fireEvent.click(within(box1).getByRole('checkbox', { name: t('sidebar.inbox') }));
    await waitFor(() => expect(accountSets()[1]).toEqual({ notifyFolders: ['Old/Projects', 'Work'] }));
  });

  it('the folders and quiet hours wait while the account\'s own notifications are off', async () => {
    engine.accounts.a1 = { notify: false };
    render(<Settings page="notifications" onClose={() => {}} />);
    const perAccount = await waitFor(() => {
      const s = screen.getByRole('switch', { name: t('mobile.settings.notifyAccount', { account: A1.email }) });
      expect(s.getAttribute('aria-checked')).toBe('false');
      return s;
    });
    expect(screen.queryByRole('button', { name: `${t('settings.notifications.configureFolders')}: ${A1.email}` })).toBeNull();
    fireEvent.click(perAccount);
    await waitFor(() => expect(screen.getByRole('button', { name: `${t('settings.notifications.configureFolders')}: ${A1.email}` })).toBeTruthy());
  });

  it('priority senders: listed, added trimmed and once, through quiet hours by default, toggled and removed', async () => {
    engine.prefs = { importantSenders: [{ match: 'boss@corp.example', throughQuietHours: true }] };
    render(<Settings page="notifications" onClose={() => {}} />);
    const section = await waitFor(() => screen.getByRole('region', { name: t('notifyPolicy.allowlist.title') }));
    await waitFor(() => expect(within(section).getByText('boss@corp.example')).toBeTruthy());

    const input = within(section).getByRole('textbox', { name: t('notifyPolicy.allowlist.placeholder') });
    fireEvent.change(input, { target: { value: '  Partner.Example ' } });
    fireEvent.click(within(section).getByRole('button', { name: t('notifyPolicy.allowlist.add') }));
    await waitFor(() => expect(prefSets()).toEqual([{ importantSenders: [
      { match: 'boss@corp.example', throughQuietHours: true },
      { match: 'Partner.Example', throughQuietHours: true },
    ] }]));
    await waitFor(() => expect(input.value).toBe(''));

    // The same sender again, in another case: nothing saved.
    fireEvent.change(input, { target: { value: 'BOSS@corp.example' } });
    fireEvent.click(within(section).getByRole('button', { name: t('notifyPolicy.allowlist.add') }));
    expect(prefSets()).toHaveLength(1);

    const through = within(section).getAllByRole('checkbox', { name: t('notifyPolicy.allowlist.throughQuietHours') });
    expect(through.map((c) => c.checked)).toEqual([true, true]);
    fireEvent.click(through[0]);
    await waitFor(() => expect(prefSets()[1]).toEqual({ importantSenders: [
      { match: 'boss@corp.example', throughQuietHours: false },
      { match: 'Partner.Example', throughQuietHours: true },
    ] }));

    fireEvent.click(within(section).getByRole('button', { name: `${t('common.remove')}: boss@corp.example` }));
    await waitFor(() => expect(prefSets()[2]).toEqual({ importantSenders: [{ match: 'Partner.Example', throughQuietHours: true }] }));
    await waitFor(() => expect(within(section).queryByText('boss@corp.example')).toBeNull());
  });

  it('priority senders: an empty list says so', async () => {
    render(<Settings page="notifications" onClose={() => {}} />);
    const section = await waitFor(() => screen.getByRole('region', { name: t('notifyPolicy.allowlist.title') }));
    await waitFor(() => expect(within(section).getByText(t('notifyPolicy.allowlist.empty'))).toBeTruthy());
  });
});
