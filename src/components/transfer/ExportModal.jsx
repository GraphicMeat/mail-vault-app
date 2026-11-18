import React, { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useT } from '../../i18n/index.js';
import { DesktopViewEnv } from '../settings/DesktopViewEnv';
import { TransferExportView } from '../settings/views/TransferExportView';
import { exportTransfer } from '../../services/workflows/transferAccounts';
import { transferErrorKey, TRANSFER_PASSWORD_MIN } from '../../services/transfer/transferErrors';

/**
 * Export accounts to an encrypted transfer file. Rendered by App.jsx in the
 * MAIN window only: exportTransfer reads accounts through getAccounts, whose
 * legacy repairs can write the keychain from the calling window's cache.
 * Mounted only while open, so closing drops the passwords with the component.
 */
export function ExportModal({ accounts, onClose }) {
  const t = useT();
  const [selected, setSelected] = useState(() => new Set(accounts.map(a => a.id)));
  const [includeAppSettings, setIncludeAppSettings] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [exported, setExported] = useState(null);

  const ready = selected.size > 0 && [...password].length >= TRANSFER_PASSWORD_MIN && password === confirm;
  const toggle = id => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    setExported(null);
    try {
      const accountIds = accounts.map(a => a.id).filter(id => selected.has(id));
      const data = await exportTransfer({ accountIds, includeAppSettings, password });
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filename = `MailVault-transfer-${new Date().toISOString().split('T')[0]}.mvtransfer`;
      // Written to exactly the path the dialog returned: a sandboxed app is
      // granted that path only, and the dialog applies the filter's extension.
      const destPath = await save({ defaultPath: filename, filters: [{ name: t('settings.transfer.fileType'), extensions: ['mvtransfer'] }] });
      if (!destPath) return;
      await window.__TAURI__.core.invoke('save_attachment_to', { filename, contentBase64: data, destPath });
      setPassword('');
      setConfirm('');
      setExported(accountIds.length);
    } catch (err) {
      setError(transferErrorKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} dismissable={!busy} portal title={t('settings.transfer.exportTitle')}
      footer={<div className="flex justify-end gap-2 w-full">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{exported !== null ? t('common.close') : t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={run} disabled={!ready || busy} loading={busy}>
          {busy ? t('settings.transfer.encrypting') : t('settings.transfer.exportTitle')}
        </Button>
      </div>}>
      <DesktopViewEnv>
        <TransferExportView accounts={accounts} selected={selected} onToggle={toggle} minPassword={TRANSFER_PASSWORD_MIN}
          password={password} onPassword={setPassword} confirm={confirm} onConfirm={setConfirm}
          error={error ? t(error.key, error.values) : null} exported={exported}
          options={<label className="flex items-center gap-2 text-sm text-mail-text">
            <input type="checkbox" className="accent-mail-accent" checked={includeAppSettings} onChange={e => setIncludeAppSettings(e.target.checked)} />
            {t('settings.transfer.includeAppSettings')}
          </label>} />
      </DesktopViewEnv>
    </Dialog>
  );
}
