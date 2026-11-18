// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { AccountGroupField } from '../AccountGroupField';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { usePrivacyStore } from '../../../stores/privacyStore';
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
afterEach(() => { cleanup(); usePrivacyStore.setState({ enabled: false }); vi.restoreAllMocks(); });

const input = () => screen.getByRole('combobox', { name: 'Group' });
const group = () => screen.getByRole('group', { name: 'Existing groups' });

it('shows assigned group as a chip with empty input and in account list', () => {
  render(<AccountSettings accounts={accounts} />);
  expect(input().value).toBe('');
  expect(screen.getByRole('button', { name: 'Remove Personal' })).toBeTruthy();
  expect(screen.getByText(/Remove the chip for no group/)).toBeTruthy();
  expect(within(document.querySelector('.account-settings-list')).getByText('Work')).toBeTruthy();
});
it('chip x clears the group', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Personal' }));
  expect(useSettingsStore.getState().accountGroups.a).toBeUndefined();
});
it('chip x clears with a draft after the browser mouse down sequence', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value: 'Study' } });
  const remove = screen.getByRole('button', { name: 'Remove Personal' });
  if (fireEvent.mouseDown(remove)) fireEvent.blur(input(), { relatedTarget: remove });
  fireEvent.click(remove);
  expect(useSettingsStore.getState().accountGroups.a).toBeUndefined();
});
it('chip x clears with a draft when reached by keyboard', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value: 'Study' } });
  const remove = screen.getByRole('button', { name: 'Remove Personal' });
  fireEvent.blur(input(), { relatedTarget: remove });
  fireEvent.click(remove);
  expect(useSettingsStore.getState().accountGroups.a).toBeUndefined();
});
it('assigns visible casing without reviving removed accounts', () => {
  useSettingsStore.setState({ accountGroups: { removed: 'work', a: 'Work' } });
  render(<AccountGroupField accountId="b" />);
  fireEvent.click(within(group()).getByRole('button', { name: 'Work 1' }));
  expect(useSettingsStore.getState().accountGroups).toEqual({ a: 'Work', b: 'Work' });
});
it('Enter assigns a new name and empties input', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'Study' } });
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(useSettingsStore.getState().accountGroups.a).toBe('Study');
  expect(input().value).toBe('');
});
it('Enter reuses existing group casing', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'work' } });
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(useSettingsStore.getState().accountGroups.a).toBe('Work');
});
it('blur commits typed text', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'Study' } });
  fireEvent.blur(input());
  expect(useSettingsStore.getState().accountGroups.a).toBe('Study');
});
it('lists matching existing groups; clicking assigns one', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'Wo' } });
  fireEvent.click(screen.getByRole('option', { name: /Work/ }));
  expect(useSettingsStore.getState().accountGroups.a).toBe('Work');
});
it('offers Create for a new name; picking it assigns', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'Study' } });
  fireEvent.click(screen.getByRole('option', { name: /Create.*Study/ }));
  expect(useSettingsStore.getState().accountGroups.a).toBe('Study');
});
it('does not offer Create for an exact case-insensitive match', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'work' } });
  expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
});
it('cloud lists each group once with account count', () => {
  useSettingsStore.setState({ accountGroups: { a: 'Work', b: 'work', removed: 'Personal' } });
  render(<AccountGroupField accountId="a" />);
  expect(within(group()).getAllByRole('button')).toHaveLength(1);
  expect(within(group()).getByRole('button', { name: 'Work 2' })).toBeTruthy();
  expect(group().textContent).not.toContain('Personal');
});
it('sorts the live group names in the picker', () => {
  useSettingsStore.setState({ accountGroups: { a: 'Work', b: 'Home', removed: 'Zebra' } });
  render(<AccountGroupField accountId="a" />);
  expect(within(group()).getAllByRole('button').map(button => button.textContent)).toEqual(['Home 1', 'Work 1']);
});
it('cloud picks a group and marks it pressed; pressed pill clears', () => {
  render(<AccountGroupField accountId="a" />);
  fireEvent.click(within(group()).getByRole('button', { name: 'Work 1' }));
  expect(useSettingsStore.getState().accountGroups.a).toBe('Work');
  expect(within(group()).getByRole('button', { name: 'Work 2' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(group()).getByRole('button', { name: 'Work 2' }));
  expect(useSettingsStore.getState().accountGroups.a).toBeUndefined();
});
it('switching accounts resets the draft', () => {
  const { rerender } = render(<AccountGroupField accountId="a" />);
  fireEvent.change(input(), { target: { value: 'Draft' } });
  rerender(<AccountGroupField accountId="b" />);
  expect(input().value).toBe('');
});
it('privacy mode masks chip, cloud, and suggestions', () => {
  vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  usePrivacyStore.setState({ enabled: true });
  render(<AccountGroupField accountId="a" />);
  expect(document.querySelector('.account-group-field').textContent).not.toContain('Personal');
  expect(document.querySelector('.account-group-field').textContent).not.toContain('Work');
  expect(input().classList.contains('mv-private-input')).toBe(true);
  fireEvent.change(input(), { target: { value: 'Wo' } });
  expect(screen.queryAllByRole('option')).toHaveLength(0);
});
