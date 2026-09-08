// @vitest-environment jsdom
import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsPage } from '../../SettingsPage';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';
import { useSettingsWindow } from '../../../hooks/useSettingsWindow';
import { SettingsBubble } from '../SettingsBubble';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));
// Keep Settings' account navigation real; the feature's mail-loading view is
// replaced with an observable consumer of the account it would load.
vi.mock('../../TimeCapsule', () => ({
  TimeCapsuleView: ({ accountId }) => <output aria-label="Feature account">{accountId}</output>,
}));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [], activeAccountId: null });
  useSettingsStore.setState({ emailTemplates: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Session({ initialTab }) {
  const session = useSettingsWindow();
  const [location, setLocation] = useState('');
  useEffect(() => session.openSettings({ tab: initialTab }), [initialTab, session.openSettings]);
  return <>
    <button>Read mail</button>
    <button onClick={() => session.openSettings()}>Open Settings</button>
    <button onClick={() => session.openSettings({ tab: 'templates' })}>Open templates</button>
    {session.isMinimized && <SettingsBubble location={location} onRestore={session.openSettings} onClose={session.closeSettings} />}
    {session.isMounted && <SettingsPage key={session.request.id} initialTab={session.request.tab} minimized={session.isMinimized}
      onNavigationLabelChange={setLocation} onMinimize={session.minimizeSettings} onClose={session.closeSettings} />}
  </>;
}
const minimize = () => fireEvent.click(screen.getByRole('button', { name: t('settingsPage.minimize') }));
const restore = () => fireEvent.click(screen.getByRole('button', { name: t('settingsPage.restore') }));

it('restores Appearance Layout at Message rows without resetting its scroller or controls', () => {
  render(<Session />);
  fireEvent.click(screen.getByRole('tab', { name: 'Layout' }));
  const content = screen.getByTestId('settings-content');
  const messageRows = screen.getByRole('group', { name: 'Message rows' });
  content.scrollTop = 640;
  minimize();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(screen.getByTestId('settings-bubble').textContent).toContain('Appearance · Layout');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: t('settingsPage.restore') }));
  restore();
  expect(screen.getByRole('tab', { name: 'Layout' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('settings-content')).toBe(content);
  expect(content.scrollTop).toBe(640);
  expect(screen.getByRole('group', { name: 'Message rows' })).toBe(messageRows);
});

it('keeps an unfinished template edit when minimized and restores the same form', () => {
  render(<Session initialTab="templates" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add Template' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Project update' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Template body' }), { target: { value: 'Still writing this reply.' } });
  minimize();
  expect(useSettingsStore.getState().emailTemplates).toEqual([]);
  restore();
  expect(screen.getByRole('textbox', { name: 'Template name' }).value).toBe('Project update');
  expect(screen.getByRole('textbox', { name: 'Template body' }).value).toBe('Still writing this reply.');
});

it('releases mail keyboard control while minimized and restores modal Escape behavior', () => {
  render(<Session />);
  minimize();
  const mail = screen.getByRole('button', { name: 'Read mail' });
  act(() => mail.focus());
  fireEvent.keyDown(mail, { key: 'Escape' });
  expect(screen.getByRole('button', { name: t('settingsPage.restore') })).toBeTruthy();
  restore();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(screen.queryByTestId('settings-page')).toBeNull();
});

it('resumes from the ordinary Settings entry and follows an explicit page link', () => {
  render(<Session />);
  fireEvent.click(screen.getByRole('tab', { name: 'Layout' }));
  const content = screen.getByTestId('settings-content');
  minimize();
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
  expect(screen.getByTestId('settings-content')).toBe(content);
  expect(screen.getByRole('tab', { name: 'Layout' }).getAttribute('aria-selected')).toBe('true');
  minimize();
  fireEvent.click(screen.getByRole('button', { name: 'Open templates' }));
  expect(screen.getByRole('button', { name: 'Add Template' })).toBeTruthy();
  expect(screen.queryByTestId('settings-bubble')).toBeNull();
});

it('closes a minimized session instead of restoring it when the bubble close button is used', () => {
  render(<Session initialTab="templates" />);
  minimize();
  fireEvent.click(screen.getByRole('button', { name: t('settingsPage.close') }));
  expect(screen.queryByTestId('settings-page')).toBeNull();
  expect(screen.queryByTestId('settings-bubble')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
  expect(screen.getByRole('tab', { name: 'Colors' }).getAttribute('aria-selected')).toBe('true');
});

it('keeps the selected feature account when another mailbox becomes active while minimized', () => {
  const accounts = [
    { id: 'studio', email: 'studio@example.test' },
    { id: 'personal', email: 'personal@example.test' },
    { id: 'archive', email: 'archive@example.test' },
  ];
  useMailStore.setState({ accounts, activeAccountId: 'studio' });
  render(<Session initialTab="time-capsule" />);
  const accountPicker = screen.getByRole('group', { name: t('settings.accounts.accounts') });
  fireEvent.click(within(accountPicker).getByRole('button', { name: 'personal@example.test' }));
  const feature = screen.getByLabelText('Feature account');
  expect(feature.textContent).toBe('personal');

  minimize();
  act(() => useMailStore.setState({ activeAccountId: 'archive', accounts: [...accounts] }));
  restore();

  expect(screen.getByLabelText('Feature account')).toBe(feature);
  expect(feature.textContent).toBe('personal');
  expect(within(accountPicker).getByRole('button', { name: 'personal@example.test' }).getAttribute('aria-pressed')).toBe('true');
  expect(useMailStore.getState().activeAccountId).toBe('archive');
});

it('retains a search and its result scroller through repeated restores, then opens the selected result', () => {
  render(<Session />);
  const navigation = screen.getByRole('navigation', { name: 'Settings' });
  const search = within(navigation).getByRole('textbox', { name: 'Find a setting' });
  fireEvent.change(search, { target: { value: 'date' } });
  const results = navigation.querySelector('.settings-nav-pages');
  const dateFormat = within(navigation).getByRole('button', { name: /^Date Format/ });
  results.scrollTop = 180;

  for (let cycle = 0; cycle < 2; cycle += 1) {
    minimize();
    restore();
    expect(within(navigation).getByRole('textbox', { name: 'Find a setting' })).toBe(search);
    expect(search.value).toBe('date');
    expect(results.scrollTop).toBe(180);
    expect(within(navigation).getByRole('button', { name: /^Date Format/ })).toBe(dateFormat);
  }

  fireEvent.click(dateFormat);
  expect(screen.getByRole('tab', { name: 'Date & time' }).getAttribute('aria-selected')).toBe('true');
  expect(search.value).toBe('');
});
