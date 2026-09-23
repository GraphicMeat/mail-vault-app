import React from 'react';
import { Button } from '../ui/Button';
import { useT } from '../../i18n/index.js';

/**
 * "Move to another computer" in Settings > Accounts. Both actions open their
 * modal in the MAIN window (App.jsx, components/transfer/): a detached Settings
 * window cannot write settings to disk, and its keychain cache is not the one
 * that must see the result.
 */
export function AccountTransfer({ accounts, onExportAccounts, onImportAccounts }) {
  const t = useT();
  return (
    <div className="mt-6 pt-4 border-t border-mail-border">
      <div className="text-sm font-medium text-mail-text-muted mb-1">{t('settings.transfer.title')}</div>
      <p className="text-xs text-mail-text-muted mb-3">{t('settings.transfer.description')}</p>
      <div className="flex flex-wrap gap-2">
        {onExportAccounts && <Button size="sm" onClick={onExportAccounts} disabled={!accounts.length}>{t('settings.transfer.export')}</Button>}
        {onImportAccounts && <Button size="sm" onClick={onImportAccounts}>{t('settings.transfer.import')}</Button>}
      </div>
    </div>
  );
}
