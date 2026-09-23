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
