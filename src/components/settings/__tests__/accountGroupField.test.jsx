// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import '../../../services/workflows/bindStoreActions';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));
const accounts = [
  { id: 'a', name: 'Alice', email: 'alice@example.test', password: 'x', imapHost: 'imap.example.test' },
  { id: 'b', name: 'Bob', email: 'bob@example.test', password: 'x', imapHost: 'imap.example.test' },
];
beforeEach(() => {
  useSettingsStore.setState({ accountGroups: { a: 'Personal', b: 'Work' }, accountColors: {},
    displayNames: {}, signatures: {}, accountOrder: [], hiddenAccounts: {} });
  useMailStore.setState({ accounts, activeAccountId: 'a', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected' });
});
afterEach(cleanup);

it('shows group in Profile and below account email', () => {
  render(<AccountSettings accounts={accounts} />);
  expect(screen.getByRole('combobox', { name: 'Group' }).value).toBe('Personal');
  const list = document.querySelector('.account-settings-list');
  expect(within(list).getByText('Work')).toBeTruthy();
});
it('saves on blur and Enter, and clears on empty input', () => {
  render(<AccountSettings accounts={accounts} />);
  const input = screen.getByRole('combobox', { name: 'Group' });
  fireEvent.change(input, { target: { value: 'Study' } });
  fireEvent.blur(input);
  expect(useSettingsStore.getState().accountGroups.a).toBe('Study');
  fireEvent.change(input, { target: { value: 'work' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(useSettingsStore.getState().accountGroups.a).toBe('Work');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(useSettingsStore.getState().accountGroups.a).toBeUndefined();
});
it('suggests existing group names', () => {
  render(<AccountSettings accounts={accounts} />);
  const input = screen.getByRole('combobox', { name: 'Group' });
  expect(input.getAttribute('list')).toBeTruthy();
  expect(document.querySelector(`datalist[id="${input.getAttribute('list')}"] option[value="Work"]`)).toBeTruthy();
});
