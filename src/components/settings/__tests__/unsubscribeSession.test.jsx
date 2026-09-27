// @vitest-environment jsdom

// Settings > Unsubscribe's loaded senders belong to the Settings session:
// they survive another page and a minimize, and go when Settings closes.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../../../services/daemonClient', () => ({ daemonCall: (...args) => mocks.daemonCall(...args) }));
vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const { SettingsPage } = await import('../../SettingsPage');
const { useMailStore } = await import('../../../stores/mailStore');
const { useUnsubscribeSendersStore } = await import('../../../stores/unsubscribeStore');
const { useSettingsWindow } = await import('../../../hooks/useSettingsWindow');
const { SettingsBubble } = await import('../SettingsBubble');
const { t } = await import('../../../i18n');

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [{ id: 'acc-a', email: 'a@example.test' }], activeAccountId: 'acc-a' });
  useUnsubscribeSendersStore.getState().clear();
  mocks.daemonCall.mockReset().mockImplementation(async (method, params) => method === 'unsubscribe.senders'
    ? [{ address: 'news@list.test', name: 'List News', accountId: params.accountId, count: 1, method: 'browser', listUnsubscribe: '<https://list.test/u>' }]
    : []);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Session() {
  const session = useSettingsWindow();
  React.useEffect(() => session.openSettings({ tab: 'unsubscribe' }), [session.openSettings]);
  return <>
    {session.isMinimized && <SettingsBubble onRestore={session.openSettings} onClose={session.closeSettings} />}
    {session.isMounted && <SettingsPage key={session.request.id} initialTab={session.request.tab} minimized={session.isMinimized}
      onMinimize={session.minimizeSettings} onClose={session.closeSettings} />}
  </>;
}
const nav = label => [...document.querySelectorAll('.settings-nav-item')].find(item => item.textContent.trim() === label);
const sendersCalls = () => mocks.daemonCall.mock.calls.filter(([method]) => method === 'unsubscribe.senders').length;

it('keeps the loaded senders across another page and a minimize, and drops them when Settings closes', async () => {
  render(<Session />);
  await screen.findByText('List News');
  expect(sendersCalls()).toBe(1);

  fireEvent.click(nav(t('settings.appearance.appearance')));
  expect(screen.queryByText('List News')).toBeNull();
  fireEvent.click(nav(t('unsubscribe.tabLabel')));
  expect(screen.getByText('List News')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: t('settingsPage.minimize') }));
  fireEvent.click(screen.getByRole('button', { name: t('settingsPage.restore') }));
  expect(screen.getByText('List News')).toBeTruthy();
  expect(sendersCalls()).toBe(1);

  fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
  expect(screen.queryByTestId('settings-page')).toBeNull();
  expect(useUnsubscribeSendersStore.getState().byAccount).toEqual({});
});
