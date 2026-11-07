// Add an account. The first screen picks the provider: Google and Microsoft sign in through the
// system sign-in sheet (`onOAuth(provider)`, oauth.js), "Fastmail and other JMAP" opens the JMAP
// form (email, app password or token, and the server URL under Advanced; the engine finds the
// server when none is typed), and "Other (IMAP)" opens the IMAP form below. A JMAP server the
// engine found on another domain is never sent the password unasked: the form names its host and
// sends again only when the user confirms (the URL then counts as typed). While a sign-in runs,
// Cancel stays live: it ends the flow (`onOAuthCancel`) and comes back to the picker at once, so a
// sheet whose answer never comes cannot strand the user.
// The IMAP form: email and password first, then the server, prefilled from the address's
// domain (`imap.<domain>`, 993, SSL/TLS; `smtp.<domain>`, 465, SSL/TLS) and editable. The engine signs in before it saves, so the
// one `onSubmit` call is the test. The form lives in this component only: the password is sent once
// per submit and never reaches the store, storage or a log. A refused sign-in clears it; a network
// or server mistake keeps it, so fixing the host is not a retype.
import React, { useEffect, useRef, useState } from 'react';
import { useT } from './i18n.js';
import { errorKey } from './errors.js';

const DEFAULT_PORT = { ssl: 993, starttls: 143, none: 143 };
const DEFAULT_SMTP_PORT = { ssl: 465, starttls: 587 };
const SMTP_SECURITY = [
  ['ssl', 'account.sslTls'],
  ['starttls', 'account.starttls'],
];
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

/** The providers, in the order the first screen offers them. */
const PROVIDERS = [
  ['google', 'mobile.add.google'],
  ['microsoft', 'mobile.add.microsoft'],
  ['jmap', 'mobile.add.jmap'],
  ['imap', 'mobile.add.imap'],
];

export default function AddAccount({ onSubmit, onOAuth, onOAuthCancel, onCancel, autoStart = null }) {
  const t = useT();
  const [step, setStep] = useState('picker'); // 'picker' | 'waiting' | 'credentials' | 'server' | 'jmap'
  const [jmapUrl, setJmapUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [confirmHost, setConfirmHost] = useState(null); // { host, jmapUrl } while asking
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [host, setHost] = useState('');
  const [hostEdited, setHostEdited] = useState(false);
  const [port, setPort] = useState('993');
  const [security, setSecurity] = useState('ssl');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpHostEdited, setSmtpHostEdited] = useState(false);
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpSecurity, setSmtpSecurity] = useState('ssl');
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const portNumber = Number(port);
  const portOk = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;
  const smtpPortNumber = Number(smtpPort);
  const smtpPortOk = Number.isInteger(smtpPortNumber) && smtpPortNumber > 0 && smtpPortNumber < 65536;
  const canNext = looksLikeEmail(email) && password.length > 0;
  const canSubmit = !busy && canNext && host.trim().length > 0 && portOk && smtpHost.trim().length > 0 && smtpPortOk;

  // Each run's number: a run the user cancelled here is over for this screen, whatever it answers.
  const run = useRef(0);

  const signInWith = async (provider) => {
    if (step !== 'picker' || !onOAuth) return;
    const mine = ++run.current;
    setErrorCode(null);
    setStep('waiting');
    let result;
    try {
      result = await onOAuth(provider);
    } catch {
      result = { ok: false, code: 'INTERNAL' };
    }
    if (mine !== run.current) return;
    // Added: the caller moves on (this screen goes away). Otherwise back to the picker; a cancel is
    // the user's own choice and says nothing.
    if (result?.ok) return;
    setStep('picker');
    if (result?.code !== 'CANCELLED') setErrorCode(result?.code ?? 'INTERNAL');
  };

  const cancelFlow = () => {
    run.current += 1;
    onOAuthCancel?.();
    setErrorCode(null);
    setStep('picker');
  };

  const choose = (provider) => {
    if (provider === 'imap') {
      setErrorCode(null);
      setStep('credentials');
    } else if (provider === 'jmap') {
      setErrorCode(null);
      setConfirmHost(null);
      setStep('jmap');
    } else if (provider === 'google' || provider === 'microsoft') {
      signInWith(provider);
    }
  };

  // Perf-gate screenshot hook (App.jsx `?ui=signin`): starts that provider's sign-in once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStart && !autoStarted.current) {
      autoStarted.current = true;
      choose(autoStart);
    }
  });

  const next = (e) => {
    e.preventDefault();
    if (!canNext) return;
    if (!hostEdited) setHost(`imap.${domainOf(email)}`);
    if (!smtpHostEdited) setSmtpHost(`smtp.${domainOf(email)}`);
    setErrorCode(null);
    setStep('server');
  };

  const changeSecurity = (value) => {
    // A port still on the old default follows the new mode; a typed one is left alone.
    if (Number(port) === DEFAULT_PORT[security]) setPort(String(DEFAULT_PORT[value]));
    setSecurity(value);
  };

  const changeSmtpSecurity = (value) => {
    if (Number(smtpPort) === DEFAULT_SMTP_PORT[smtpSecurity]) setSmtpPort(String(DEFAULT_SMTP_PORT[value]));
    setSmtpSecurity(value);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErrorCode(null);
    const form = { email: email.trim(), password, imapHost: host.trim(), imapPort: portNumber, security,
      smtpHost: smtpHost.trim(), smtpPort: smtpPortNumber, smtpSecurity };
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

  const canJmap = !busy && looksLikeEmail(email) && password.length > 0;

  const sendJmap = async (url) => {
    setBusy(true);
    setErrorCode(null);
    setConfirmHost(null);
    const typed = (url ?? jmapUrl).trim();
    const form = { kind: 'jmap', email: email.trim(), password, ...(typed ? { jmapUrl: typed } : {}) };
    let result;
    try {
      result = await onSubmit(form);
    } catch {
      result = { ok: false, code: 'INTERNAL' };
    }
    setBusy(false);
    if (result?.ok || result?.code === 'AUTH_FAILED') setPassword('');
    if (result?.ok) return;
    if (result?.code === 'CONFIRM_HOST' && result.host && result.jmapUrl) {
      setConfirmHost({ host: result.host, jmapUrl: result.jmapUrl });
      return;
    }
    if (result?.code === 'JMAP_NOT_FOUND') setAdvanced(true);
    setErrorCode(result?.code ?? 'INTERNAL');
  };

  const submitJmap = (e) => {
    e.preventDefault();
    if (canJmap) sendJmap();
  };

  const confirmJmapHost = () => {
    const url = confirmHost?.jmapUrl;
    if (!url || !canJmap) return;
    setJmapUrl(url);
    setAdvanced(true);
    sendJmap(url);
  };

  return (
    <section className="mv-add" aria-labelledby="mv-add-title">
      <div className="mv-add__bar">
        {step === 'waiting' ? (
          <button type="button" className="mv-textbtn" onClick={cancelFlow}>
            {t('common.cancel')}
          </button>
        ) : onCancel && (
          <button type="button" className="mv-textbtn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
        )}
      </div>
      <h1 id="mv-add-title" className="mv-add__title">{t('mobile.add.title')}</h1>
      <p className="mv-add__lead">{t('mobile.add.lead')}</p>

      {step === 'picker' || step === 'waiting' ? (
        <div className="mv-add__form">
          <ul className="mv-providers" aria-label={t('mobile.add.pickProvider')}>
            {PROVIDERS.map(([id, key]) => (
              <li key={id}>
                <button
                  type="button"
                  className="mv-provider"
                  data-provider={id}
                  disabled={step === 'waiting' || (id !== 'imap' && id !== 'jmap' && !onOAuth)}
                  onClick={() => choose(id)}
                >
                  {t(key)}
                </button>
              </li>
            ))}
          </ul>
          {step === 'waiting' && <p className="mv-add__waiting" role="status">{t('mobile.add.waiting')}</p>}
          {errorCode && <p className="mv-add__error" role="alert">{t(errorKey(errorCode))}</p>}
        </div>
      ) : step === 'jmap' ? (
        <form className="mv-add__form" onSubmit={submitJmap} noValidate>
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
              disabled={busy}
              onChange={(e) => { setEmail(e.target.value); setConfirmHost(null); }}
            />
          </Field>
          <Field id="mv-add-jmap-secret" label={t('mobile.add.jmapSecret')}>
            <input
              id="mv-add-jmap-secret"
              className="mv-input"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <p className="mv-add__hint">{t('mobile.add.jmapHint')}</p>
          <button
            type="button"
            className="mv-textbtn"
            aria-expanded={advanced}
            aria-controls="mv-add-jmap-advanced"
            disabled={busy}
            onClick={() => setAdvanced((v) => !v)}
          >
            {t('mobile.add.advanced')}
          </button>
          {advanced && (
            <div id="mv-add-jmap-advanced">
              <Field id="mv-add-jmap-url" label={t('mobile.add.jmapUrl')}>
                <input
                  id="mv-add-jmap-url"
                  className="mv-input"
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={jmapUrl}
                  disabled={busy}
                  onChange={(e) => { setJmapUrl(e.target.value); setConfirmHost(null); }}
                />
              </Field>
            </div>
          )}
          {confirmHost && (
            <div className="mv-add__confirm" role="alert">
              <p dir="auto">{t('mobile.add.confirmHost', { host: confirmHost.host })}</p>
              <button type="button" className="mv-primary" disabled={!canJmap} onClick={confirmJmapHost}>
                {t('mobile.add.confirmHostYes')}
              </button>
            </div>
          )}
          {errorCode && <p className="mv-add__error" role="alert">{t(errorKey(errorCode))}</p>}
          {!confirmHost && (
            <button type="submit" className="mv-primary" disabled={!canJmap} aria-busy={busy}>
              {busy ? t('mobile.add.signingIn') : t('mobile.add.signIn')}
            </button>
          )}
          <button type="button" className="mv-textbtn" disabled={busy} onClick={() => { setErrorCode(null); setConfirmHost(null); setStep('picker'); }}>
            {t('common.back')}
          </button>
        </form>
      ) : step === 'credentials' ? (
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
          <button type="button" className="mv-textbtn" onClick={() => setStep('picker')}>
            {t('common.back')}
          </button>
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
          <h2 className="mv-add__section">{t('mobile.add.smtpServer')}</h2>
          <Field id="mv-add-smtp-host" label={t('mobile.add.smtpHost')}>
            <input
              id="mv-add-smtp-host"
              className="mv-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={smtpHost}
              disabled={busy}
              onChange={(e) => { setSmtpHost(e.target.value); setSmtpHostEdited(true); }}
            />
          </Field>
          <div className="mv-add__row">
            <Field id="mv-add-smtp-port" label={t('mobile.add.smtpPort')}>
              <input
                id="mv-add-smtp-port"
                className="mv-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={smtpPort}
                disabled={busy}
                onChange={(e) => setSmtpPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
            </Field>
            <Field id="mv-add-smtp-security" label={t('mobile.add.smtpSecurity')}>
              <select
                id="mv-add-smtp-security"
                className="mv-input"
                value={smtpSecurity}
                disabled={busy}
                onChange={(e) => changeSmtpSecurity(e.target.value)}
              >
                {SMTP_SECURITY.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
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
