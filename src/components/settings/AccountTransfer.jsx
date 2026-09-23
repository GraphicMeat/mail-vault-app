import React, { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useT } from '../../i18n/index.js';
import { exportTransfer } from '../../services/workflows/transferAccounts';
import { transferErrorKey, TRANSFER_PASSWORD_MIN } from '../../services/transfer/transferErrors';

export const TRANSFER_INPUT = 'w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text placeholder-mail-text-muted focus:outline-none focus:border-mail-accent';

/** "Move to another computer": Export runs here (read-only); Import is the main window's (onImportAccounts). */
export function AccountTransfer({ accounts, onImportAccounts }) {
  const t = useT();
  const [exporting, setExporting] = useState(false);
  return (
    <div className="mt-6 pt-4 border-t border-mail-border">
      <div className="text-sm font-medium text-mail-text-muted mb-1">{t('settings.transfer.title')}</div>
      <p className="text-xs text-mail-text-muted mb-3">{t('settings.transfer.description')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setExporting(true)} disabled={!accounts.length}>{t('settings.transfer.export')}</Button>
        {onImportAccounts && <Button size="sm" onClick={onImportAccounts}>{t('settings.transfer.import')}</Button>}
      </div>
      {/* Mounted only while open: closing drops the passwords with the component. */}
      {exporting && <ExportModal accounts={accounts} onClose={() => setExporting(false)} />}
    </div>
  );
}

function ExportModal({ accounts, onClose }) {
  const t = useT();
  const [selected, setSelected] = useState(() => new Set(accounts.map(a => a.id)));
  const [includeAppSettings, setIncludeAppSettings] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [exported, setExported] = useState(null);

  const mismatch = confirm !== '' && password !== confirm;
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
      let destPath = await save({ defaultPath: filename, filters: [{ name: t('settings.transfer.fileType'), extensions: ['mvtransfer'] }] });
      if (!destPath) return;
      // The importing side only reads a .mvtransfer file.
      if (!/\.mvtransfer$/i.test(destPath)) destPath += '.mvtransfer';
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
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={run} disabled={!ready || busy} loading={busy}>
          {busy ? t('settings.transfer.encrypting') : t('settings.transfer.exportTitle')}
        </Button>
      </div>}>
      <fieldset>
        <legend className="text-xs font-medium text-mail-text-muted mb-2">{t('settings.transfer.accounts')}</legend>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {accounts.map(a => (
            <label key={a.id} className="flex items-center gap-2 text-sm text-mail-text">
              <input type="checkbox" className="accent-mail-accent" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="truncate">{a.email}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-mail-text">
        <input type="checkbox" className="accent-mail-accent" checked={includeAppSettings} onChange={e => setIncludeAppSettings(e.target.checked)} />
        {t('settings.transfer.includeAppSettings')}
      </label>
      <div>
        <label htmlFor="transfer-export-password" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.password')}</label>
        <input id="transfer-export-password" type="password" autoComplete="new-password" data-autofocus className={TRANSFER_INPUT}
          value={password} onChange={e => setPassword(e.target.value)} aria-describedby="transfer-export-hint" />
        <p id="transfer-export-hint" className="text-xs text-mail-text-muted mt-1">{t('settings.transfer.passwordHint', { count: TRANSFER_PASSWORD_MIN })}</p>
      </div>
      <div>
        <label htmlFor="transfer-export-confirm" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.confirmPassword')}</label>
        <input id="transfer-export-confirm" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
          value={confirm} onChange={e => setConfirm(e.target.value)} aria-invalid={mismatch || undefined} />
        {mismatch && <p className="text-xs text-mail-danger mt-1">{t('settings.transfer.passwordMismatch')}</p>}
      </div>
      <p className="flex items-start gap-2 text-xs text-mail-text-muted">
        <AlertTriangle size={14} aria-hidden="true" className="text-mail-warning flex-shrink-0 mt-0.5" />
        {t('settings.transfer.warning')}
      </p>
      {error && <p role="alert" className="text-sm text-mail-danger">{t(error.key, error.values)}</p>}
      {exported !== null && (
        <p role="status" className="flex items-center gap-2 text-sm text-mail-text">
          <Check size={14} aria-hidden="true" className="text-mail-success" />
          {t('settings.transfer.exported', { count: exported })}
        </p>
      )}
    </Dialog>
  );
}
