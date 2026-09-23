// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '../../../i18n';

const transfer = vi.hoisted(() => ({
  exportTransfer: vi.fn(),
  decryptTransfer: vi.fn(),
  applyImport: vi.fn(),
}));
vi.mock('../../../services/workflows/transferAccounts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...transfer }; // real planImport
});
const dialog = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
const db = vi.hoisted(() => ({ getAccounts: vi.fn() }));
vi.mock('../../../services/db', async (importOriginal) => ({ ...(await importOriginal()), getAccounts: db.getAccounts }));

import { AccountTransfer } from '../AccountTransfer';
import { AccountImportModal } from '../../AccountImportModal';

const accounts = [
  { id: 'a', email: 'a@example.test', imapHost: 'imap.example.test' },
  { id: 'b', email: 'b@example.test', imapHost: 'imap.example.test' },
];
const invoke = vi.fn();

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  window.__TAURI__ = { core: { invoke } };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); delete window.__TAURI__; });

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AccountTransfer (settings section)', () => {
  it('renders the section with Export and Import', () => {
    const onImportAccounts = vi.fn();
    render(<AccountTransfer accounts={accounts} onImportAccounts={onImportAccounts} />);
    expect(screen.getByText(t('settings.transfer.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.import') }));
    expect(onImportAccounts).toHaveBeenCalledTimes(1);
  });

  it('enables Export only for a matching password of at least 12 characters', () => {
    render(<AccountTransfer accounts={accounts} />);
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.export') }));
    const exportButton = () => screen.getByRole('button', { name: t('settings.transfer.exportTitle') });
    type(t('settings.transfer.password'), '12345678901');
    type(t('settings.transfer.confirmPassword'), '12345678901');
    expect(exportButton().disabled).toBe(true);
    type(t('settings.transfer.password'), '123456789012');
    type(t('settings.transfer.confirmPassword'), '123456789013');
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByText(t('settings.transfer.passwordMismatch'))).toBeTruthy();
    type(t('settings.transfer.confirmPassword'), '123456789012');
    expect(exportButton().disabled).toBe(false);
    // Unchecking every account disables it again.
    fireEvent.click(screen.getByLabelText('a@example.test'));
    fireEvent.click(screen.getByLabelText('b@example.test'));
    expect(exportButton().disabled).toBe(true);
  });

  it('encrypts, saves with the .mvtransfer extension and reports the count', async () => {
    transfer.exportTransfer.mockResolvedValue('QkFTRTY0');
    dialog.save.mockResolvedValue('/Users/x/Desktop/moved');
    invoke.mockResolvedValue('ok');
    render(<AccountTransfer accounts={accounts} />);
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.export') }));
    fireEvent.click(screen.getByLabelText('b@example.test'));
    type(t('settings.transfer.password'), 'correct horse battery');
    type(t('settings.transfer.confirmPassword'), 'correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.exportTitle') }));
    await screen.findByText(t('settings.transfer.exported', { count: 1 }));
    expect(transfer.exportTransfer).toHaveBeenCalledWith({ accountIds: ['a'], includeAppSettings: true, password: 'correct horse battery' });
    const opts = dialog.save.mock.calls[0][0];
    expect(opts.defaultPath).toMatch(/^MailVault-transfer-\d{4}-\d{2}-\d{2}\.mvtransfer$/);
    expect(opts.filters).toEqual([{ name: t('settings.transfer.fileType'), extensions: ['mvtransfer'] }]);
    expect(invoke).toHaveBeenCalledWith('save_attachment_to', expect.objectContaining({
      contentBase64: 'QkFTRTY0', destPath: '/Users/x/Desktop/moved.mvtransfer' }));
    // The password does not outlive the export.
    expect(screen.getByLabelText(t('settings.transfer.password')).value).toBe('');
  });
});

describe('AccountImportModal', () => {
  const bundle = { accounts: [
    { id: 'a', email: 'a@example.test', imapHost: 'imap.example.test' },
    { id: 'n', email: 'new@example.test', imapHost: 'imap.example.test' },
  ], appSettings: { layoutMode: 'split' } };

  async function unlock() {
    dialog.open.mockResolvedValue('/Users/x/MailVault-transfer.mvtransfer');
    invoke.mockResolvedValue('QkFTRTY0');
    transfer.decryptTransfer.mockResolvedValue(bundle);
    db.getAccounts.mockResolvedValue([accounts[0]]);
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.chooseFile') }));
    await screen.findByText('MailVault-transfer.mvtransfer');
    type(t('settings.transfer.password'), 'correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.unlock') }));
    await screen.findByText(t('settings.transfer.alreadyAdded'));
  }

  it('shows an account already here as disabled, imports the rest, then reloads', async () => {
    const reload = vi.fn();
    applyImportResolves({ imported: 1, aiKeyError: false, settingsError: false });
    render(<AccountImportModal onClose={() => {}} reload={reload} />);
    await unlock();
    expect(invoke).toHaveBeenCalledWith('read_file_base64', { path: '/Users/x/MailVault-transfer.mvtransfer' });
    expect(transfer.decryptTransfer).toHaveBeenCalledWith({ password: 'correct horse battery', data: 'QkFTRTY0' });
    const existing = screen.getByRole('checkbox', { name: /^a@example\.test/ });
    expect(existing.disabled).toBe(true);
    expect(existing.checked).toBe(false);
    expect(screen.getByLabelText('new@example.test').checked).toBe(true);
    expect(screen.getByLabelText(t('settings.transfer.applyAppSettings')).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.importButton') }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(transfer.applyImport).toHaveBeenCalledWith(bundle, { selectedIds: ['n'], applyAppSettings: true });
  });

  it('holds the reload behind Restart now when a setting or the AI key did not save', async () => {
    const reload = vi.fn();
    applyImportResolves({ imported: 1, aiKeyError: true, settingsError: true });
    render(<AccountImportModal onClose={() => {}} reload={reload} />);
    await unlock();
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.importButton') }));
    await screen.findByText(t('settings.transfer.warnings.settings'));
    expect(screen.getByText(t('settings.transfer.warnings.aiKey'))).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.restartNow') }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('maps a wrong password to the generic decrypt message', async () => {
    dialog.open.mockResolvedValue('/Users/x/f.mvtransfer');
    invoke.mockResolvedValue('QkFTRTY0');
    transfer.decryptTransfer.mockRejectedValue(new Error('E_TRANSFER_DECRYPT'));
    render(<AccountImportModal onClose={() => {}} reload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.chooseFile') }));
    await screen.findByText('f.mvtransfer');
    type(t('settings.transfer.password'), 'wrong password!');
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.unlock') }));
    await screen.findByText(t('settings.transfer.errors.decrypt'));
  });

  it('never says nothing was imported when the apply step fails late', async () => {
    const reload = vi.fn();
    transfer.applyImport.mockRejectedValue(new Error('apply_config failed'));
    render(<AccountImportModal onClose={() => {}} reload={reload} />);
    await unlock();
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.importButton') }));
    await screen.findByText(t('settings.transfer.errors.partial', { message: 'apply_config failed' }));
    fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.restartNow') }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

function applyImportResolves(result) { transfer.applyImport.mockResolvedValue(result); }
