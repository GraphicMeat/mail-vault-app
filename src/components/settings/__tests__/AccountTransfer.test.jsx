// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from '../../../i18n';
import { AccountTransfer } from '../AccountTransfer';

afterEach(cleanup);

it('renders the section and hands both actions to the main window', () => {
  const onExportAccounts = vi.fn();
  const onImportAccounts = vi.fn();
  render(<AccountTransfer accounts={[{ id: 'a', email: 'a@example.test' }]} onExportAccounts={onExportAccounts} onImportAccounts={onImportAccounts} />);
  expect(screen.getByText(t('settings.transfer.title'))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.export') }));
  fireEvent.click(screen.getByRole('button', { name: t('settings.transfer.import') }));
  expect(onExportAccounts).toHaveBeenCalledTimes(1);
  expect(onImportAccounts).toHaveBeenCalledTimes(1);
});

it('disables Export with no accounts to export', () => {
  render(<AccountTransfer accounts={[]} onExportAccounts={() => {}} onImportAccounts={() => {}} />);
  expect(screen.getByRole('button', { name: t('settings.transfer.export') }).disabled).toBe(true);
});

it('puts "Set up the mobile app" above "Move to another computer" and hands it to the main window', () => {
  const onSetupPhone = vi.fn();
  render(<AccountTransfer accounts={[{ id: 'a', email: 'a@example.test' }]} onSetupPhone={onSetupPhone} onExportAccounts={() => {}} onImportAccounts={() => {}} />);
  const phone = screen.getByText(t('settings.phoneSetup.title'));
  const move = screen.getByText(t('settings.transfer.title'));
  expect(phone.compareDocumentPosition(move) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText(t('settings.phoneSetup.description'))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: t('settings.phoneSetup.show') }));
  expect(onSetupPhone).toHaveBeenCalledTimes(1);
});

it('disables the phone set-up with no accounts to send', () => {
  render(<AccountTransfer accounts={[]} onSetupPhone={() => {}} onExportAccounts={() => {}} onImportAccounts={() => {}} />);
  expect(screen.getByRole('button', { name: t('settings.phoneSetup.show') }).disabled).toBe(true);
});
