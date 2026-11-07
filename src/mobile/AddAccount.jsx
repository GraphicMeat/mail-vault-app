// Add an IMAP account: email and password first, then the server, prefilled from the address's
// domain (`imap.<domain>`, 993, SSL/TLS) and editable. The engine signs in before it saves, so the
// one `onSubmit` call is the test. The form lives in this component only: the password is sent once
// per submit and never reaches the store, storage or a log. A refused sign-in clears it; a network
// or server mistake keeps it, so fixing the host is not a retype.
import React, { useState } from 'react';
import { useT } from './i18n.js';
import { errorKey } from './errors.js';

const DEFAULT_PORT = { ssl: 993, starttls: 143, none: 143 };
const SECURITY = [
  ['ssl', 'account.sslTls'],
  ['starttls', 'account.starttls'],
  ['none', 'account.none'],
];

const domainOf = (email) => {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : '';
};
const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

function Field({ id, label, children }) {
  return (
    <div className="mv-field">
      <label className="mv-field__label" htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

export default function AddAccount({ onSubmit, onCancel }) {
  const t = useT();
  const [step, setStep] = useState('credentials'); // 'credentials' | 'server'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [host, setHost] = useState('');
  const [hostEdited, setHostEdited] = useState(false);
  const [port, setPort] = useState('993');
  const [security, setSecurity] = useState('ssl');
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const portNumber = Number(port);
  const portOk = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;
  const canNext = looksLikeEmail(email) && password.length > 0;
  const canSubmit = !busy && canNext && host.trim().length > 0 && portOk;

  const next = (e) => {
    e.preventDefault();
    if (!canNext) return;
    if (!hostEdited) setHost(`imap.${domainOf(email)}`);
    setErrorCode(null);
    setStep('server');
  };

  const changeSecurity = (value) => {
    // A port still on the old default follows the new mode; a typed one is left alone.
    if (Number(port) === DEFAULT_PORT[security]) setPort(String(DEFAULT_PORT[value]));
    setSecurity(value);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErrorCode(null);
    const form = { email: email.trim(), password, imapHost: host.trim(), imapPort: portNumber, security };
    let result;
    try {
      result = await onSubmit(form);
    } catch {
      result = { ok: false, code: 'INTERNAL' };
    }
    setBusy(false);
    if (result?.ok || result?.code === 'AUTH_FAILED') setPassword('');
    if (!result?.ok) setErrorCode(result?.code ?? 'INTERNAL');
  };

  return (
    <section className="mv-add" aria-labelledby="mv-add-title">
      <div className="mv-add__bar">
        {onCancel && (
          <button type="button" className="mv-textbtn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
        )}
      </div>
      <h1 id="mv-add-title" className="mv-add__title">{t('mobile.add.title')}</h1>
      <p className="mv-add__lead">{t('mobile.add.lead')}</p>

      {step === 'credentials' ? (
        <form className="mv-add__form" onSubmit={next} noValidate>
          <Field id="mv-add-email" label={t('mobile.add.email')}>
            <input
              id="mv-add-email"
              className="mv-input"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field id="mv-add-password" label={t('mobile.add.password')}>
            <input
              id="mv-add-password"
              className="mv-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button type="submit" className="mv-primary" disabled={!canNext}>{t('common.next')}</button>
        </form>
      ) : (
        <form className="mv-add__form" onSubmit={submit} noValidate>
          <p className="mv-add__who" dir="auto">{email.trim()}</p>
          {/* Here too: a refused sign-in clears it, and the retry needs it typed again. */}
          <Field id="mv-add-password" label={t('mobile.add.password')}>
            <input
              id="mv-add-password"
              className="mv-input"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <h2 className="mv-add__section">{t('mobile.add.server')}</h2>
          <Field id="mv-add-host" label={t('mobile.add.host')}>
            <input
              id="mv-add-host"
              className="mv-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={host}
              disabled={busy}
              onChange={(e) => { setHost(e.target.value); setHostEdited(true); }}
            />
          </Field>
          <div className="mv-add__row">
            <Field id="mv-add-port" label={t('mobile.add.port')}>
              <input
                id="mv-add-port"
                className="mv-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={port}
                disabled={busy}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
            </Field>
            <Field id="mv-add-security" label={t('account.security')}>
              <select
                id="mv-add-security"
                className="mv-input"
                value={security}
                disabled={busy}
                onChange={(e) => changeSecurity(e.target.value)}
              >
                {SECURITY.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
              </select>
            </Field>
          </div>
          {errorCode && <p className="mv-add__error" role="alert">{t(errorKey(errorCode))}</p>}
          <button type="submit" className="mv-primary" disabled={!canSubmit} aria-busy={busy}>
            {busy ? t('mobile.add.signingIn') : t('mobile.add.signIn')}
          </button>
          <button type="button" className="mv-textbtn" disabled={busy} onClick={() => { setErrorCode(null); setStep('credentials'); }}>
            {t('common.back')}
          </button>
        </form>
      )}
    </section>
  );
}
