// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { groupAccounts } from '../../../utils/groupAccounts';
import { t } from '../../../i18n';
import '../../../services/workflows/bindStoreActions';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const accounts = ['solo', 'work1', 'home1', 'work2'].map(id => ({ id, name: id, email: `${id}@example.test` }));
const groups = { work1: 'Work', work2: 'Work', home1: 'Personal' };
const listEl = () => document.querySelector('.account-settings-list');
const sectionNames = () => groupAccounts(useSettingsStore.getState().getOrderedAccounts(accounts), useSettingsStore.getState().accountGroups).map(s => s.name);

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  useSettingsStore.setState({ signatures: {}, displayNames: {}, accountColors: {}, hiddenAccounts: {},
    accountOrder: ['solo', 'work1', 'home1', 'work2'], accountGroups: groups, accountListWidth: 260 });
  useMailStore.setState({ accounts, activeAccountId: 'solo', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('lists accounts in their sidebar groups, each group a labelled list', () => {
  render(<AccountSettings accounts={accounts} />);
  const work = within(listEl()).getByRole('list', { name: 'Work' });
  expect(within(work).getAllByRole('listitem').map(li => li.dataset.accountId)).toEqual(['work1', 'work2']);
  expect(within(listEl()).getByRole('list', { name: 'Personal' })).toBeTruthy();
  expect(within(listEl()).getByRole('list', { name: t('settings.accounts.accounts') })).toBeTruthy();
});

it('moves a group up and down and the sidebar order follows', () => {
  render(<AccountSettings accounts={accounts} />);
  expect(sectionNames()).toEqual([null, 'Work', 'Personal']);
  const up = name => screen.getByRole('button', { name: t('settings.accounts.moveGroupUp', { name }) });
  const down = name => screen.getByRole('button', { name: t('settings.accounts.moveGroupDown', { name }) });
  expect(up('Work').disabled).toBe(true);
  expect(down('Personal').disabled).toBe(true);
  fireEvent.click(down('Work'));
  expect(sectionNames()).toEqual([null, 'Personal', 'Work']);
  fireEvent.click(up('Work'));
  expect(sectionNames()).toEqual([null, 'Work', 'Personal']);
});

it('reorders inside a group without splitting it', () => {
  render(<AccountSettings accounts={accounts} />);
  const grip = screen.getByRole('button', { name: t('settings.accounts.reorderAccount', { email: 'work2@example.test' }) });
  fireEvent.keyDown(grip, { key: 'ArrowUp' });
  expect(useSettingsStore.getState().getOrderedAccounts(accounts).map(a => a.id)).toEqual(['solo', 'work2', 'work1', 'home1']);
});

it('shows no group headers when nobody has a group', () => {
  useSettingsStore.setState({ accountGroups: {} });
  render(<AccountSettings accounts={accounts} />);
  expect(within(listEl()).getAllByRole('list')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /move .* up/i })).toBeNull();
});

it('resizes the account list from its separator, never below 260px, and keeps the width', () => {
  const { unmount } = render(<AccountSettings accounts={accounts} />);
  const separator = screen.getByRole('separator', { name: t('settings.accounts.resizeAccountList') });
  expect(separator.getAttribute('aria-valuenow')).toBe('260');
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  expect(useSettingsStore.getState().accountListWidth).toBe(280);
  expect(listEl().style.getPropertyValue('--account-list-width')).toBe('280px');
  fireEvent.keyDown(separator, { key: 'ArrowLeft' });
  fireEvent.keyDown(separator, { key: 'ArrowLeft' });
  expect(useSettingsStore.getState().accountListWidth).toBe(260);
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  unmount();
  render(<AccountSettings accounts={accounts} />);
  expect(listEl().style.getPropertyValue('--account-list-width')).toBe('280px');
});

it('drags the separator to widen the list', () => {
  render(<AccountSettings accounts={accounts} />);
  vi.spyOn(listEl(), 'getBoundingClientRect').mockReturnValue({ left: 100, right: 360, width: 260, top: 0, bottom: 500, height: 500 });
  const separator = screen.getByRole('separator', { name: t('settings.accounts.resizeAccountList') });
  fireEvent.mouseDown(separator, { button: 0, clientX: 360 });
  fireEvent.mouseMove(document, { clientX: 460 });
  fireEvent.mouseUp(document, { clientX: 460 });
  expect(useSettingsStore.getState().accountListWidth).toBe(360);
});
