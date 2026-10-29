// @vitest-environment jsdom
//
// Settings > Backup & Restore: the one-time Import & Export page is the last
// sub-tab, and opening Backup lands on the ongoing backup settings, not on it.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../BackupRestore', () => ({ default: () => <div data-testid="import-export-page" /> }));
vi.mock('../BackupConfig', () => ({ default: () => <div data-testid="config-page" /> }));
vi.mock('../BackupSchedule', () => ({ default: () => <div data-testid="schedule-page" /> }));
vi.mock('../abd/AbdSection', () => ({ default: () => <div data-testid="abd-page" /> }));

import BackupSettings from '../BackupSettings';
import en from '../../../i18n/locales/en.json';

afterEach(cleanup);

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

describe('Backup sub-tabs', () => {
  it('lists Import & Export last, under its own name', () => {
    render(<BackupSettings />);
    expect(en['settings.backup.importExport.tab']).toBe('Import & Export');
    expect(tabNames()).toEqual([
      en['settings.backup.backupSettings'],
      en['settings.backup.backupSchedule'],
      en['settings.backup.abd.tab'],
      en['settings.backup.importExport.tab'],
    ]);
  });

  it('opens on Backup Settings, the first tab', () => {
    render(<BackupSettings />);
    expect(screen.getByTestId('config-page')).toBeTruthy();
    expect(screen.queryByTestId('import-export-page')).toBeNull();
  });

  it('a link to the old restore page still opens Import & Export', () => {
    render(<BackupSettings initialSubTab="restore" />);
    expect(screen.getByTestId('import-export-page')).toBeTruthy();
    expect(screen.getByRole('tab', { name: en['settings.backup.importExport.tab'] }).getAttribute('aria-selected')).toBe('true');
  });
});
