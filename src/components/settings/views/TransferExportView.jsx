// Move to another computer > Export as a view: the accounts to seal into the encrypted transfer
// file, the file's password twice (at least `minPassword` characters), what it holds, and how the
// last export went. Desktop shows it in its Export dialog (transfer/ExportModal.jsx), the phone on
// its own page. `selected`: the chosen account ids (a Set), `onToggle(id)`; `disabled` while an
// export runs; `options`: rows only one app has (desktop's "Include app settings"); `error`: text;
// `exported`: how many accounts the last export sealed; `children`: after everything else.
import React from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { TRANSFER_INPUT } from '../../transfer/transferStyles';
import { useT, useViewEnv } from './viewContext';

export function TransferExportView({
  accounts, selected, onToggle, disabled = false, options = null, password, onPassword, confirm, onConfirm,
  minPassword, error = null, exported = null, children = null,
}) {
  const t = useT();
  const { Private } = useViewEnv();
  const mismatch = confirm !== '' && password !== confirm;
  return (
    <>
      {/* A fieldset is as wide as its widest row unless told otherwise: a long address would widen the page. */}
      <fieldset className="min-w-0">
        <legend className="text-xs font-medium text-mail-text-muted mb-2">{t('settings.transfer.accounts')}</legend>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {accounts.map(a => (
            <label key={a.id} className="flex items-center gap-2 min-w-0 text-sm text-mail-text">
              <input type="checkbox" className="accent-mail-accent" checked={selected.has(a.id)} disabled={disabled || undefined} onChange={() => onToggle(a.id)} />
              <span className="truncate min-w-0"><Private kind="email">{a.email}</Private></span>
            </label>
          ))}
        </div>
      </fieldset>
      {options}
      <div>
        <label htmlFor="transfer-export-password" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.password')}</label>
        <input id="transfer-export-password" type="password" autoComplete="new-password" data-autofocus className={TRANSFER_INPUT}
          value={password} disabled={disabled || undefined} onChange={e => onPassword(e.target.value)} aria-describedby="transfer-export-hint" />
        <p id="transfer-export-hint" className="text-xs text-mail-text-muted mt-1">{t('settings.transfer.passwordHint', { count: minPassword })}</p>
      </div>
      <div>
        <label htmlFor="transfer-export-confirm" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.confirmPassword')}</label>
        <input id="transfer-export-confirm" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
          value={confirm} disabled={disabled || undefined} onChange={e => onConfirm(e.target.value)} aria-invalid={mismatch || undefined} />
        {mismatch && <p className="text-xs text-mail-danger mt-1">{t('settings.transfer.passwordMismatch')}</p>}
      </div>
      <p className="flex items-start gap-2 text-xs text-mail-text-muted">
        <AlertTriangle size={14} aria-hidden="true" className="text-mail-warning flex-shrink-0 mt-0.5" />
        {t('settings.transfer.warning')}
      </p>
      {error && <p role="alert" className="text-sm text-mail-danger">{error}</p>}
      {exported !== null && (
        <p role="status" className="flex items-center gap-2 text-sm text-mail-text">
          <Check size={14} aria-hidden="true" className="text-mail-success" />
          {t('settings.transfer.exported', { count: exported })}
        </p>
      )}
      {children}
    </>
  );
}
