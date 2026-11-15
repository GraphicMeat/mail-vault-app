// Settings > Move to another computer: desktop's export (ExportModal.jsx) on the phone. The chosen
// accounts, with their passwords or sign-in tokens, are sealed into a desktop `.mvtransfer` file
// with a password of at least 12 characters (`mobile.transfer.export`, engine
// `transfer_export.rs`: core's desktop mapping and `.mvtransfer` envelope), handed to the system
// share sheet (save to Files, AirDrop, ...), and deleted again as soon as the sheet answers
// (`mobile.transfer.discard`), whatever it answered. Desktop's Import opens the file. An account
// with no saved password or token is left out and named. Bringing accounts in from a computer is
// the QR code (ImportFromDesktop.jsx), not a file.
import React, { useId, useRef, useState, useEffect } from 'react';
import { daemonCall, shareFile } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';

const MIN_PASSWORD = 12;

export default function TransferSettings() {
  const t = useT();
  const id = useId();
  const accounts = useMobileStore((s) => s.accounts);
  const [left, setLeft] = useState(() => new Set()); // the accounts not chosen
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { count, skipped }
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const chosen = accounts.filter((a) => !left.has(a.id));
  const mismatch = confirm !== '' && password !== confirm;
  const ready = chosen.length > 0 && [...password].length >= MIN_PASSWORD && password === confirm && !busy;
  const toggle = (accountId) => setLeft((prev) => {
    const next = new Set(prev);
    if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
    return next;
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    let path = null;
    try {
      const reply = await daemonCall('mobile.transfer.export', { password, accountIds: chosen.map((a) => a.id) });
      if (!reply?.ok) {
        if (mounted.current) setError(reply?.code === 'PASSWORD_SHORT' ? t('settings.transfer.passwordHint', { count: MIN_PASSWORD }) : t('settings.transfer.errors.generic', { message: reply?.code || '' }));
        return;
      }
      path = reply.path;
      // The password has done its work: it does not stay on screen.
      if (mounted.current) {
        setPassword('');
        setConfirm('');
      }
      await shareFile({ path, name: reply.name, mime: 'application/octet-stream' });
      if (mounted.current) setDone({ count: reply.count, skipped: reply.skipped || [] });
    } catch (e) {
      if (mounted.current) setError(t('settings.transfer.errors.generic', { message: e?.code || e?.message || '' }));
    } finally {
      // The file holds every secret it carries: gone as soon as the sheet answers.
      if (path) await daemonCall('mobile.transfer.discard', { path }).catch(() => {});
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div data-mv-transfer>
      <p className="mv-settings__note">{t('settings.transfer.description')}</p>
      <h2 className="mv-settings__heading">{t('settings.transfer.accounts')}</h2>
      <div className="mv-settings__list">
        {accounts.map((a) => (
          <label key={a.id} className="mv-setting" data-mv-transfer-account={a.id}>
            <input type="checkbox" checked={!left.has(a.id)} disabled={busy} onChange={() => toggle(a.id)} />
            <span className="mv-setting__text">
              <span className="mv-setting__label" dir="auto">{a.email}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mv-add__form">
        <div className="mv-field">
          <label className="mv-field__label" htmlFor={`${id}-pw`}>{t('settings.transfer.password')}</label>
          <input id={`${id}-pw`} className="mv-input" type="password" autoComplete="new-password" value={password} disabled={busy}
            aria-describedby={`${id}-hint`} onChange={(e) => setPassword(e.target.value)} />
          <span className="mv-setting__hint" id={`${id}-hint`}>{t('settings.transfer.passwordHint', { count: MIN_PASSWORD })}</span>
        </div>
        <div className="mv-field">
          <label className="mv-field__label" htmlFor={`${id}-confirm`}>{t('settings.transfer.confirmPassword')}</label>
          <input id={`${id}-confirm`} className="mv-input" type="password" autoComplete="new-password" value={confirm} disabled={busy}
            onChange={(e) => setConfirm(e.target.value)} />
          {mismatch && <span className="mv-setting__hint mv-settings__note--error">{t('settings.transfer.passwordMismatch')}</span>}
        </div>
        <p className="mv-setting__hint">{t('settings.transfer.warning')}</p>
        <button type="button" className="mv-primary" disabled={!ready} onClick={run}>
          {busy ? t('settings.transfer.encrypting') : t('settings.transfer.exportTitle')}
        </button>
      </div>
      {error && <p className="mv-settings__note mv-settings__note--error" role="alert">{error}</p>}
      {done && <p className="mv-settings__note" role="status">{t('settings.transfer.exported', { count: done.count })}</p>}
      {done?.skipped.length > 0 && (
        <p className="mv-settings__note mv-settings__note--error">
          {t('settings.transfer.errors.incomplete', { emails: done.skipped.map((s) => s.email).join(', ') })}
        </p>
      )}
    </div>
  );
}
