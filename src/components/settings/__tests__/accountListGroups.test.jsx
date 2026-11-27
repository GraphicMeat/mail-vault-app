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

const groupGrip = name => screen.getByRole('button', { name: t('settings.accounts.reorderGroup', { name }) });

it('has no up and down arrows on group headers', () => {
  render(<AccountSettings accounts={accounts} />);
  expect(document.querySelector('.account-settings-group-move')).toBeNull();
  expect(screen.queryByRole('button', { name: /move .* (up|down)/i })).toBeNull();
});

it('drags a group by its header grip and the sidebar order follows', () => {
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    constructor(type, options = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; this.isPrimary = options.isPrimary ?? true; }
  });
  // Three stacked sections, 100px each: ungrouped, Work, Personal.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!this.matches('section')) return { left: 0, right: 260, top: 0, bottom: 300, width: 260, height: 300 };
    const index = [...this.parentElement.children].filter(el => el.matches('section')).indexOf(this);
    return { left: 0, right: 260, top: index * 100, bottom: (index + 1) * 100, width: 260, height: 100 };
  });
  render(<AccountSettings accounts={accounts} />);
  expect(sectionNames()).toEqual([null, 'Work', 'Personal']);
  const drag = (name, y) => {
    const grip = groupGrip(name);
    fireEvent.pointerDown(grip, { button: 0, clientX: 20, clientY: 110 });
    fireEvent.pointerMove(grip, { clientX: 20, clientY: y });
    expect(document.querySelector('[data-group-drop-before], [data-group-drop-end]')).toBeTruthy();
    fireEvent.pointerUp(grip, { clientX: 20, clientY: y });
  };
  drag('Work', 290);
  expect(sectionNames()).toEqual([null, 'Personal', 'Work']);
  drag('Work', 20);
  expect(sectionNames()).toEqual([null, 'Work', 'Personal']);
  expect(document.querySelector('[data-group-drop-before], [data-group-drop-end]')).toBeNull();
});

it('moves a group with the arrow keys on its grip', () => {
  render(<AccountSettings accounts={accounts} />);
  fireEvent.keyDown(groupGrip('Work'), { key: 'ArrowDown' });
  expect(sectionNames()).toEqual([null, 'Personal', 'Work']);
  fireEvent.keyDown(groupGrip('Work'), { key: 'ArrowUp' });
  expect(sectionNames()).toEqual([null, 'Work', 'Personal']);
  fireEvent.keyDown(groupGrip('Work'), { key: 'ArrowUp' });
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
  expect(screen.queryByRole('button', { name: /reorder group/i })).toBeNull();
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

it('keeps the list and settings side by side at any width, each column at least 260px', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(`${process.cwd()}/src/styles/settings.css`, 'utf8');
  expect(css).not.toMatch(/\.account-settings-layout\s*\{[^}]*flex-direction:\s*column/);
  expect(css).toMatch(/\.account-settings-list\s*\{[^}]*min-width:\s*260px/);
  expect(css).toMatch(/\.account-settings-detail\s*\{[^}]*min-width:\s*260px/);
  expect(css).not.toMatch(/\.account-settings-resizer\s*\{[^}]*display:\s*none/);
});
