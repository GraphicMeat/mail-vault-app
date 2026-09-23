import React, { useState } from 'react';
import { AlertTriangle, FileKey } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { getAccounts } from '../services/db';
import { decryptTransfer, planImport, applyImport } from '../services/workflows/transferAccounts';
import { transferErrorKey } from '../services/transfer/transferErrors';
import { TRANSFER_INPUT } from './settings/AccountTransfer';

const reloadWindow = () => window.location.reload();

/**
 * Import an encrypted transfer file. Rendered by App.jsx in the MAIN window
 * only: the detached Settings window cannot write settings to disk, and the
 * main window's keychain cache would drop the imported secrets on its next
 * write. The main window reloads once the import has landed.
 *
 * Only the chosen path is kept before Unlock; the file is read then. The
 * password and the decrypted bundle live in this component's state and go
 * when it unmounts.
 */
export function AccountImportModal({ onClose, reload = reloadWindow }) {
  const t = useT();
  const [path, setPath] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(null); // 'decrypting' | 'importing'
  const [error, setError] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [applyAppSettings, setApplyAppSettings] = useState(true);
  const [warnings, setWarnings] = useState(null);
  // Accounts may already be saved: offer the restart that shows them.
  const [needsRestart, setNeedsRestart] = useState(false);

  const hasAppSettings = !!(bundle?.appSettings || bundle?.appConfig);
  const fileName = path ? path.split(/[\\/]/).pop() : null;

  const chooseFile = async () => {
    setError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, filters: [{ name: t('settings.transfer.fileType'), extensions: ['mvtransfer'] }] });
      if (picked) setPath(picked);
    } catch (err) {
      setError(transferErrorKey(err));
    }
  };

  const unlock = async () => {
    setBusy('decrypting');
    setError(null);
    try {
      const data = await window.__TAURI__.core.invoke('read_file_base64', { path });
      const decrypted = await decryptTransfer({ password, data });
      const plan = planImport(decrypted, await getAccounts());
      setPassword('');
      setBundle(decrypted);
      setRows(plan.rows);
      setSelected(new Set(plan.rows.filter(r => !r.alreadyAdded).map(r => r.fileId)));
    } catch (err) {
      setError(transferErrorKey(err));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy('importing');
    setError(null);
    try {
      const result = await applyImport(bundle, {
        selectedIds: rows.map(r => r.fileId).filter(id => selected.has(id)),
        applyAppSettings: hasAppSettings && applyAppSettings,
      });
      if (result.settingsError || result.aiKeyError) setWarnings(result);
      else reload();
    } catch (err) {
      const mapped = transferErrorKey(err, { applying: true });
      setError(mapped);
      setNeedsRestart(mapped.key !== 'settings.transfer.errors.keychain');
    } finally {
      setBusy(null);
    }
  };

  const toggle = id => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const done = warnings || needsRestart;
  let action;
  if (done) {
    action = <Button variant="primary" size="sm" onClick={reload}>{t('settings.transfer.restartNow')}</Button>;
  } else if (bundle) {
    action = <Button variant="primary" size="sm" onClick={runImport} loading={busy === 'importing'}
      disabled={!!busy || (selected.size === 0 && !(hasAppSettings && applyAppSettings))}>{t('settings.transfer.importButton')}</Button>;
  } else {
    action = <Button variant="primary" size="sm" onClick={unlock} loading={busy === 'decrypting'} disabled={!path || !password || !!busy}>
      {busy === 'decrypting' ? t('settings.transfer.decrypting') : t('settings.transfer.unlock')}
    </Button>;
  }

  return (
    <Dialog open onClose={onClose} dismissable={!busy} portal title={t('settings.transfer.importTitle')}
      footer={<div className="flex justify-end gap-2 w-full">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={!!busy}>{done ? t('common.close') : t('common.cancel')}</Button>
        {action}
      </div>}>
      {!bundle && (
        <>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={chooseFile} disabled={!!busy}>{t('settings.transfer.chooseFile')}</Button>
            {fileName && <span className="flex items-center gap-1.5 text-sm text-mail-text truncate min-w-0">
              <FileKey size={14} aria-hidden="true" className="flex-shrink-0 text-mail-text-muted" /><span className="truncate">{fileName}</span>
            </span>}
          </div>
          <div>
            <label htmlFor="transfer-import-password" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.password')}</label>
            <input id="transfer-import-password" type="password" autoComplete="current-password" data-autofocus className={TRANSFER_INPUT}
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && path && password && !busy) unlock(); }} />
          </div>
        </>
      )}
      {bundle && !done && (
        <>
          <fieldset>
            <legend className="text-xs font-medium text-mail-text-muted mb-2">{t('settings.transfer.accounts')}</legend>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {rows.map(row => (
                <label key={row.fileId} className={`flex items-center gap-2 text-sm ${row.alreadyAdded ? 'text-mail-text-muted' : 'text-mail-text'}`}>
                  <input type="checkbox" className="accent-mail-accent" disabled={row.alreadyAdded}
                    checked={!row.alreadyAdded && selected.has(row.fileId)} onChange={() => toggle(row.fileId)} />
                  <span className="truncate">{row.email}</span>
                  {row.alreadyAdded && <span className="ml-auto flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-mail-surface-hover text-mail-text-muted">
                    {t('settings.transfer.alreadyAdded')}
                  </span>}
                </label>
              ))}
            </div>
          </fieldset>
          {hasAppSettings && (
            <label className="flex items-center gap-2 text-sm text-mail-text">
              <input type="checkbox" className="accent-mail-accent" checked={applyAppSettings} onChange={e => setApplyAppSettings(e.target.checked)} />
              {t('settings.transfer.applyAppSettings')}
            </label>
          )}
        </>
      )}
      {warnings && (
        <div role="status" className="space-y-1">
          {warnings.settingsError && <Warning text={t('settings.transfer.warnings.settings')} />}
          {warnings.aiKeyError && <Warning text={t('settings.transfer.warnings.aiKey')} />}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-mail-danger">{t(error.key, error.values)}</p>}
    </Dialog>
  );
}

function Warning({ text }) {
  return (
    <p className="flex items-start gap-2 text-sm text-mail-text">
      <AlertTriangle size={14} aria-hidden="true" className="text-mail-warning flex-shrink-0 mt-0.5" />{text}
    </p>
  );
}
