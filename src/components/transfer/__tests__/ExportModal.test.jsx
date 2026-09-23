// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from '../../../i18n';

const transfer = vi.hoisted(() => ({ exportTransfer: vi.fn() }));
vi.mock('../../../services/workflows/transferAccounts', () => transfer);
const dialog = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);

import { ExportModal } from '../ExportModal';

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
const exportButton = () => screen.getByRole('button', { name: t('settings.transfer.exportTitle') });
const both = value => { type(t('settings.transfer.password'), value); type(t('settings.transfer.confirmPassword'), value); };

it('enables Export only for a matching password of at least 12 characters', () => {
  render(<ExportModal accounts={accounts} onClose={() => {}} />);
  both('12345678901');
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

// Characters, not UTF-16 units: 11 emoji are 22 code units.
it('counts the password in characters', () => {
  render(<ExportModal accounts={accounts} onClose={() => {}} />);
  both('😀'.repeat(11));
  expect(exportButton().disabled).toBe(true);
  both('😀'.repeat(12));
  expect(exportButton().disabled).toBe(false);
});

it('encrypts, writes exactly the path the dialog returned and reports the count', async () => {
  transfer.exportTransfer.mockResolvedValue('QkFTRTY0');
  dialog.save.mockResolvedValue('/Users/x/Desktop/moved');
  invoke.mockResolvedValue('ok');
  render(<ExportModal accounts={accounts} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: t('common.cancel') })).toBeTruthy();
  fireEvent.click(screen.getByLabelText('b@example.test'));
  both('correct horse battery');
  fireEvent.click(exportButton());
  await screen.findByText(t('settings.transfer.exported', { count: 1 }));
  expect(transfer.exportTransfer).toHaveBeenCalledWith({ accountIds: ['a'], includeAppSettings: true, password: 'correct horse battery' });
  const opts = dialog.save.mock.calls[0][0];
  expect(opts.defaultPath).toMatch(/^MailVault-transfer-\d{4}-\d{2}-\d{2}\.mvtransfer$/);
  expect(opts.filters).toEqual([{ name: t('settings.transfer.fileType'), extensions: ['mvtransfer'] }]);
  // The sandbox grants the chosen path only; nothing is appended to it.
  expect(invoke).toHaveBeenCalledWith('save_attachment_to', expect.objectContaining({
    contentBase64: 'QkFTRTY0', destPath: '/Users/x/Desktop/moved' }));
  expect(screen.getByLabelText(t('settings.transfer.password')).value).toBe('');
  expect(screen.queryByRole('button', { name: t('common.cancel') })).toBeNull();
  expect(screen.getAllByRole('button', { name: t('common.close') }).length).toBeGreaterThan(0);
});
