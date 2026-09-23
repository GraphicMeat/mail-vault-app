// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '../../../i18n';

const transfer = vi.hoisted(() => ({ decryptTransfer: vi.fn(), applyImport: vi.fn() }));
vi.mock('../../../services/workflows/transferAccounts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...transfer }; // real planImport
});
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
const db = vi.hoisted(() => ({ getAccounts: vi.fn() }));
vi.mock('../../../services/db', async (importOriginal) => ({ ...(await importOriginal()), getAccounts: db.getAccounts }));

import { ImportModal } from '../ImportModal';

const here = { id: 'a', email: 'a@example.test', imapHost: 'imap.example.test' };
const bundle = { accounts: [here, { id: 'n', email: 'new@example.test', imapHost: 'imap.example.test' }], appSettings: { layoutMode: 'split' } };
const invoke = vi.fn();

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  window.__TAURI__ = { core: { invoke } };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); delete window.__TAURI__; });

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const importButton = () => screen.getByRole('button', { name: t('settings.transfer.importButton') });

async function unlock(file = bundle) {
  dialog.open.mockResolvedValue('/Users/x/MailVault-transfer.mvtransfer');
  invoke.mockResolvedValue('QkFTRTY0');
  transfer.decryptTransfer.mockResolvedValue(file);
  db.getAccounts.mockResolvedValue([here]);
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.chooseFile') }));
  await screen.findByText('MailVault-transfer.mvtransfer');
  type(t('settings.transfer.password'), 'correct horse battery');
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.unlock') }));
  await screen.findByText(t('settings.transfer.alreadyAdded'));
}

it('shows an account already here as disabled, imports the rest, then reloads', async () => {
  const reload = vi.fn();
  transfer.applyImport.mockResolvedValue({ imported: 1, aiKeyError: false, settingsError: false });
  render(<ImportModal onClose={() => {}} reload={reload} />);
  await unlock();
  expect(invoke).toHaveBeenCalledWith('read_file_base64', { path: '/Users/x/MailVault-transfer.mvtransfer' });
  expect(transfer.decryptTransfer).toHaveBeenCalledWith({ password: 'correct horse battery', data: 'QkFTRTY0' });
  const existing = screen.getByRole('checkbox', { name: /^a@example\.test/ });
  expect(existing.disabled).toBe(true);
  expect(existing.checked).toBe(false);
  expect(screen.getByLabelText('new@example.test').checked).toBe(true);
  expect(screen.getByLabelText(t('settings.transfer.applyAppSettings')).checked).toBe(true);
  fireEvent.click(importButton());
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(transfer.applyImport).toHaveBeenCalledWith(bundle, { selectedIds: ['n'], applyAppSettings: true });
});

it('holds the reload behind Restart now when a setting or the AI key did not save', async () => {
  const reload = vi.fn();
  transfer.applyImport.mockResolvedValue({ imported: 1, aiKeyError: true, settingsError: true });
  render(<ImportModal onClose={() => {}} reload={reload} />);
  await unlock();
  fireEvent.click(importButton());
  await screen.findByText(t('settings.transfer.warnings.settings'));
  expect(screen.getByText(t('settings.transfer.warnings.aiKey'))).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.restartNow') }));
  expect(reload).toHaveBeenCalledTimes(1);
});

// Closing without a reload would leave the imported accounts invisible.
it.each(['close button', 'Escape'])('reloads instead of closing via the %s once something was imported', async how => {
  const reload = vi.fn();
  const onClose = vi.fn();
  transfer.applyImport.mockResolvedValue({ imported: 1, aiKeyError: false, settingsError: true });
  render(<ImportModal onClose={onClose} reload={reload} />);
  await unlock();
  fireEvent.click(importButton());
  await screen.findByText(t('settings.transfer.warnings.settings'));
  if (how === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it('maps a wrong password to the generic decrypt message', async () => {
  dialog.open.mockResolvedValue('/Users/x/f.mvtransfer');
  invoke.mockResolvedValue('QkFTRTY0');
  transfer.decryptTransfer.mockRejectedValue(new Error('E_TRANSFER_DECRYPT'));
  render(<ImportModal onClose={() => {}} reload={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.chooseFile') }));
  await screen.findByText('f.mvtransfer');
  type(t('settings.transfer.password'), 'wrong password!');
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.unlock') }));
  await screen.findByText(t('settings.transfer.errors.decrypt'));
});

it('never says nothing was imported when the apply step fails late', async () => {
  const reload = vi.fn();
  transfer.applyImport.mockRejectedValue(new Error('apply_config failed'));
  render(<ImportModal onClose={() => {}} reload={reload} />);
  await unlock();
  fireEvent.click(importButton());
  await screen.findByText(t('settings.transfer.errors.partial', { message: 'apply_config failed' }));
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.restartNow') }));
  expect(reload).toHaveBeenCalledTimes(1);
});

// Nothing was written: no restart to offer, and closing just closes.
it('offers no restart when the keychain was unavailable at apply time', async () => {
  const onClose = vi.fn();
  const reload = vi.fn();
  transfer.applyImport.mockRejectedValue(new Error('E_KEYCHAIN_UNAVAILABLE'));
  render(<ImportModal onClose={onClose} reload={reload} />);
  await unlock();
  fireEvent.click(importButton());
  await screen.findByText(t('settings.transfer.errors.keychain'));
  expect(screen.queryByRole('button', { name: t('settings.transfer.restartNow') })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});

it('disables Import when every row is unchecked and there are no settings to apply', async () => {
  render(<ImportModal onClose={() => {}} reload={vi.fn()} />);
  await unlock({ accounts: bundle.accounts });
  expect(screen.queryByLabelText(t('settings.transfer.applyAppSettings'))).toBeNull();
  expect(importButton().disabled).toBe(false);
  fireEvent.click(screen.getByLabelText('new@example.test'));
  expect(importButton().disabled).toBe(true);
});
