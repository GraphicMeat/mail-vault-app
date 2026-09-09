// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { SettingsPage } from '../../SettingsPage';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { safeStorage } from '../../../stores/safeStorage';
import { t } from '../../../i18n';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const accounts = [
  { id: 'studio', name: 'Studio', email: 'studio@example.test' },
  { id: 'personal', name: 'Personal', email: 'personal@example.test' },
  { id: 'archive', name: 'Archive', email: 'archive@example.test' },
];
const handle = id => screen.getByRole('button', { name: t('settings.accounts.reorderAccount', { email: `${id}@example.test` }) });
const list = () => screen.getByRole('list', { name: t('settings.accounts.accounts') });
const visibleOrder = () => within(list()).getAllByRole('listitem').map(row => row.textContent);

beforeEach(() => {
  // jsdom has no pointer layout; supply the same three stacked rows a browser measures.
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    constructor(type, options = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
      this.isPrimary = options.isPrimary ?? true;
    }
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const index = this.matches('li') ? [...this.parentElement.children].indexOf(this) : 0;
    return { left: 0, right: 260, top: index * 60, bottom: this.matches('li') ? (index + 1) * 60 : 180, width: 260, height: this.matches('li') ? 60 : 180 };
  });
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, accountColors: {}, accountOrder: ['archive', 'studio', 'personal'], hiddenAccounts: { archive: true } });
  useMailStore.setState({ accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('moves an account from its handle and persists the shared order only on drop', async () => {
  const { unmount } = render(<AccountSettings accounts={accounts} initialAccountId="studio" />);
  const grip = handle('archive');
  fireEvent.pointerDown(grip, { button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(grip, { clientX: 20, clientY: 175 });
  expect(useSettingsStore.getState().accountOrder).toEqual(['archive', 'studio', 'personal']);
  fireEvent.pointerUp(grip, { clientX: 20, clientY: 175 });
  expect(useSettingsStore.getState().accountOrder).toEqual(['studio', 'personal', 'archive']);
  expect(useSettingsStore.getState().getOrderedAccounts(accounts).map(account => account.id)).toEqual(['studio', 'personal', 'archive']);
  expect(JSON.parse(await safeStorage.getItem('mailvault-settings')).state.accountOrder).toEqual(['studio', 'personal', 'archive']);
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
  unmount();
  render(<AccountSettings accounts={accounts} />);
  expect(visibleOrder()).toEqual(['SStudiostudio@example.test', 'PPersonalpersonal@example.test', 'AArchivearchive@example.test']);
});

it('does not reorder or select an account from a handle click or dragging its name', () => {
  render(<AccountSettings accounts={accounts} initialAccountId="studio" />);
  fireEvent.pointerDown(handle('archive'), { button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerUp(handle('archive'), { clientX: 20, clientY: 30 });
  fireEvent.click(handle('archive'));
  const name = within(list()).getByRole('button', { name: /Personal personal@example.test/ });
  fireEvent.pointerDown(name, { button: 0, clientX: 100, clientY: 150 });
  fireEvent.pointerMove(name, { clientX: 100, clientY: 5 });
  fireEvent.pointerUp(name, { clientX: 100, clientY: 5 });
  expect(useSettingsStore.getState().accountOrder).toEqual(['archive', 'studio', 'personal']);
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
  fireEvent.click(name);
  expect(screen.getByRole('heading', { name: 'Personal' })).toBeTruthy();
});

it.each(['escape', 'pointercancel', 'outside'])('leaves the saved order intact when a drag ends with %s', reason => {
  render(<AccountSettings accounts={accounts} />);
  const grip = handle('archive');
  fireEvent.pointerDown(grip, { button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(grip, { clientX: 20, clientY: 175 });
  if (reason === 'escape') fireEvent.keyDown(grip, { key: 'Escape' });
  if (reason === 'pointercancel') fireEvent.pointerCancel(grip);
  fireEvent.pointerUp(grip, { clientX: reason === 'outside' ? 500 : 20, clientY: 175 });
  expect(useSettingsStore.getState().accountOrder).toEqual(['archive', 'studio', 'personal']);
});

it('reorders with the keyboard, keeps focus and selection, and respects list boundaries', () => {
  render(<AccountSettings accounts={accounts} initialAccountId="studio" />);
  const grip = handle('personal');
  grip.focus();
  fireEvent.keyDown(grip, { key: 'ArrowUp' });
  expect(useSettingsStore.getState().accountOrder).toEqual(['archive', 'personal', 'studio']);
  expect(document.activeElement).toBe(grip);
  fireEvent.keyDown(grip, { key: 'Home' });
  fireEvent.keyDown(grip, { key: 'ArrowUp' });
  expect(useSettingsStore.getState().accountOrder).toEqual(['personal', 'archive', 'studio']);
  fireEvent.keyDown(grip, { key: 'End' });
  fireEvent.keyDown(grip, { key: 'ArrowDown' });
  expect(useSettingsStore.getState().accountOrder).toEqual(['archive', 'studio', 'personal']);
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
});

it('does not offer reordering for a single account', () => {
  render(<AccountSettings accounts={[accounts[0]]} />);
  expect(screen.queryByRole('button', { name: t('settings.accounts.reorderAccount', { email: 'studio@example.test' }) })).toBeNull();
});

it('lets Escape cancel a drag before closing Settings', () => {
  function SettingsHost() {
    const [open, setOpen] = React.useState(true);
    return open && <SettingsPage initialTab="accounts" onClose={() => setOpen(false)} />;
  }
  render(<SettingsHost />);
  const grip = handle('archive');
  fireEvent.pointerDown(grip, { button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(grip, { clientX: 20, clientY: 175 });
  fireEvent.keyDown(grip, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(useSettingsStore.getState().accountOrder).toEqual(['archive', 'studio', 'personal']);
  fireEvent.keyDown(grip, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
