// A password account's password and mail servers, on its own page (AccountEditor.jsx), as desktop's
// account page has them (`settings.accounts.password`, `settings.accounts.mailServer`). Folded
// until opened. Save is the engine's `mobile.accounts.update`: it signs in to IMAP and SMTP with
// the new values first and stores nothing that was refused (the refusal shows here, what was typed
// stays). A blank password keeps the saved one. A save that worked also lifts the refused-password
// hold and "sign in again", so the store re-reads the accounts; the password leaves the screen.
// OAuth, Graph and JMAP accounts have no such form (the engine refuses them too).
import React, { useId, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { errorKey } from './errors.js';

const SECURITY = [['ssl', 'account.sslTls'], ['starttls', 'account.starttls'], ['none', 'account.none']];
const SMTP_SECURITY = [['ssl', 'account.sslTls'], ['starttls', 'account.starttls']];

/** Whether `account` signs in with a password over IMAP: the only kind this form changes. */
export function hasServerSettings(account) {
  return account?.oauth === false && (account.kind || 'imap') === 'imap';
}

const digits = (v) => v.replace(/\D/g, '').slice(0, 5);

export default function AccountServer({ account }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState(account.imapHost || '');
  const [imapPort, setImapPort] = useState(String(account.imapPort || ''));
  const [security, setSecurity] = useState(account.security || 'ssl');
  const [smtpHost, setSmtpHost] = useState(account.smtpHost || '');
  const [smtpPort, setSmtpPort] = useState(String(account.smtpPort || ''));
  const [smtpSecurity, setSmtpSecurity] = useState(account.smtpSecurity === 'starttls' ? 'starttls' : 'ssl');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // null | 'saved' | an error code

  if (!open) {
    return (
      <button type="button" className="mv-setting" data-mv-acct-server aria-expanded="false" onClick={() => setOpen(true)}>
        <span className="mv-setting__text">
          <span className="mv-setting__label">{t('settings.accounts.mailServer')}</span>
          <span className="mv-setting__hint">{t('mobile.accounts.server.hint')}</span>
        </span>
      </button>
    );
  }

  const ready = imapHost.trim() && Number(imapPort) > 0 && smtpHost.trim() && Number(smtpPort) > 0;
  const save = async () => {
    setBusy(true);
    setResult(null);
    let reply;
    try {
      reply = await daemonCall('mobile.accounts.update', {
        accountId: account.id,
        password,
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        security,
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort),
        smtpSecurity,
      });
    } catch (err) {
      reply = { ok: false, code: err?.code || 'INTERNAL' };
    }
    setBusy(false);
    if (reply?.ok) {
      setPassword('');
      setResult('saved');
      useMobileStore.getState().reloadAccounts?.();
    } else {
      setResult(reply?.code || 'INTERNAL');
    }
  };

  const field = (key, label, input) => (
    <label className="mv-acct-edit__field" htmlFor={`${id}-${key}`}>
      <span className="mv-setting__label">{label}</span>
      {input}
    </label>
  );
  const text = (key, value, set, extra = {}) => (
    <input
      id={`${id}-${key}`}
      className="mv-setting__input"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      disabled={busy}
      onChange={(e) => set(e.target.value)}
      {...extra}
    />
  );
  const pick = (key, value, set, options) => (
    <select id={`${id}-${key}`} className="mv-setting__select" value={value} disabled={busy} onChange={(e) => set(e.target.value)}>
      {options.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
    </select>
  );

  return (
    <div className="mv-acct-edit__group" data-mv-acct-server-form>
      <h3 className="mv-settings__heading">{t('settings.accounts.mailServer')}</h3>
      {field('password', t('settings.accounts.password'), text('password', password, setPassword, {
        type: 'password', autoComplete: 'current-password', placeholder: t('mobile.accounts.server.keepPassword'),
      }))}
      {field('imap-host', t('mobile.add.host'), text('imap-host', imapHost, setImapHost, { inputMode: 'url' }))}
      {field('imap-port', t('mobile.add.port'), text('imap-port', imapPort, (v) => setImapPort(digits(v)), { inputMode: 'numeric' }))}
      {field('imap-security', t('account.security'), pick('imap-security', security, setSecurity, SECURITY))}
      {field('smtp-host', t('mobile.add.smtpHost'), text('smtp-host', smtpHost, setSmtpHost, { inputMode: 'url' }))}
      {field('smtp-port', t('mobile.add.smtpPort'), text('smtp-port', smtpPort, (v) => setSmtpPort(digits(v)), { inputMode: 'numeric' }))}
      {field('smtp-security', t('mobile.add.smtpSecurity'), pick('smtp-security', smtpSecurity, setSmtpSecurity, SMTP_SECURITY))}
      {result === 'saved' && <p className="mv-settings__note" role="status">{t('mobile.accounts.server.saved')}</p>}
      {result && result !== 'saved' && (
        <p className="mv-settings__note mv-settings__note--error" role="alert">{t(errorKey(result) || 'mobile.settings.saveFailed')}</p>
      )}
      <div className="mv-acct__actions">
        <button type="button" className="mv-textbtn" data-mv-server-save disabled={busy || !ready} aria-busy={busy || undefined} onClick={save}>
          {busy ? t('mobile.add.signingIn') : t('mobile.accounts.server.save')}
        </button>
      </div>
    </div>
  );
}
