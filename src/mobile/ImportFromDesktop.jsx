// "Import from computer": the accounts of MailVault on the computer, brought over with the set-up
// code it shows (Settings > Accounts > Set up the mobile app). Four steps: what to do on the
// computer (with pictures and the FAQ entry), the camera (it reads every part of the code, "Part 2
// of 3"; a new code on the computer starts it over), the password the user picked there, and what
// was added. The camera is scanner.js; the import itself is the caller's `onImport({ frames,
// password })` (the store's `mobile.transfer.import`), answering `{ ok, imported, existing, skipped }`
// or `{ ok: false, code }`. `onDone({ imported })` after the result, `onCancel()` for Back on the
// first step. The password and the frames live in this component only and go with it.
//
// For onboarding: render this directly, with the same three props.
import React, { useEffect, useRef, useState } from 'react';
import { useT, getMobileLocale } from './i18n.js';
import { cameraAccess, scanQr, cancelScan, openCameraSettings } from './scanner.js';
import { scanUntilComplete } from './qrFrames.js';
import { faqUrl } from '../services/faqUrl.js';
import { appLink } from '../services/appLink.js';
import settingsShot from './assets/import/desktop-settings.png';
import qrShot from './assets/import/desktop-qr.png';

const MIN_PASSWORD = 12;
// The class that makes the page see-through while the camera runs behind it (mobile.css).
const SCANNING_CLASS = 'mv-import-scanning';

/** The FAQ entry with the same steps, tagged as opened from the phone. */
export function importFaqUrl(locale) {
  return appLink(`${faqUrl(locale)}#phone-import`, 'mobile_import');
}

const REASON_KEYS = {
  invalid: 'mobile.import.reason.invalid',
  'no-secret': 'mobile.import.reason.noSecret',
  internal: 'mobile.import.reason.internal',
};

const ERROR_KEYS = {
  BAD_PASSWORD: 'mobile.import.badPassword',
  PASSWORD_SHORT: 'mobile.import.passwordShort',
  INVALID: 'mobile.import.invalid',
};

function setScanning(on) {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle(SCANNING_CLASS, on);
}

export default function ImportFromDesktop({ onImport, onDone, onCancel }) {
  const t = useT();
  const [step, setStep] = useState('intro'); // 'intro' | 'scanning' | 'password' | 'result'
  const [progress, setProgress] = useState({ have: 0, total: 0 });
  const [notOurs, setNotOurs] = useState(false);
  const [scanError, setScanError] = useState(null); // 'denied' | 'failed'
  const [frames, setFrames] = useState(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const [result, setResult] = useState(null);
  // Each scan run's number: a cancelled run is over, whatever its camera answers later.
  const run = useRef(0);
  const scanningRef = useRef(false);

  const stopCamera = () => {
    run.current += 1;
    if (scanningRef.current) {
      scanningRef.current = false;
      setScanning(false);
      cancelScan();
    }
  };

  // Leaving mid-scan closes the camera and gives the page its background back.
  useEffect(() => () => stopCamera(), []);

  const startScan = async () => {
    const mine = ++run.current;
    setStep('scanning');
    setScanError(null);
    setErrorCode(null);
    setNotOurs(false);
    setProgress({ have: 0, total: 0 });
    setFrames(null);
    let access;
    try {
      access = await cameraAccess();
    } catch {
      access = 'failed';
    }
    if (mine !== run.current) return;
    if (access !== 'granted') {
      setScanError(access === 'denied' ? 'denied' : 'failed');
      return;
    }
    scanningRef.current = true;
    setScanning(true);
    let got = null;
    let failure = null;
    try {
      got = await scanUntilComplete({
        scan: scanQr,
        stopped: () => mine !== run.current,
        onProgress: (p) => {
          if (mine !== run.current) return;
          setNotOurs(p.foreign);
          if (!p.foreign) setProgress({ have: p.have, total: p.total });
        },
      });
    } catch (err) {
      failure = err?.code;
    }
    if (mine !== run.current) return;
    scanningRef.current = false;
    setScanning(false);
    if (got) {
      setFrames(got);
      setPassword('');
      setStep('password');
    } else if (failure !== 'CANCELLED') {
      setScanError(failure === 'CAMERA_DENIED' ? 'denied' : 'failed');
    }
  };

  const cancelScanning = () => {
    stopCamera();
    setScanError(null);
    setStep('intro');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy || [...password].length < MIN_PASSWORD || !frames) return;
    setBusy(true);
    setErrorCode(null);
    let reply;
    try {
      reply = await onImport({ frames, password });
    } catch {
      reply = { ok: false, code: 'INTERNAL' };
    }
    setBusy(false);
    setPassword('');
    if (reply?.ok) {
      setFrames(null);
      setResult({
        imported: reply.imported ?? [],
        existing: reply.existing ?? [],
        skipped: reply.skipped ?? [],
      });
      setStep('result');
      return;
    }
    setErrorCode(reply?.code ?? 'INTERNAL');
  };

  if (step === 'result' && result) {
    const nothing = !result.imported.length && !result.existing.length && !result.skipped.length;
    return (
      <section className="mv-add mv-import" aria-labelledby="mv-import-title">
        <div className="mv-add__bar" />
        <h1 id="mv-import-title" className="mv-add__title">{t('mobile.import.resultTitle')}</h1>
        <div className="mv-add__form">
          {nothing && <p className="mv-add__lead">{t('mobile.import.none')}</p>}
          {result.imported.length > 0 && (
            <>
              <h2 className="mv-add__section" id="mv-import-added">{t('mobile.import.imported')}</h2>
              <ul className="mv-import__list" aria-labelledby="mv-import-added">
                {result.imported.map((email) => <li key={email} dir="auto">{email}</li>)}
              </ul>
            </>
          )}
          {result.existing.length > 0 && (
            <>
              <h2 className="mv-add__section" id="mv-import-existing">{t('mobile.import.existing')}</h2>
              <ul className="mv-import__list" aria-labelledby="mv-import-existing">
                {result.existing.map((email, i) => <li key={`${email}-${i}`} dir="auto">{email}</li>)}
              </ul>
            </>
          )}
          {result.skipped.length > 0 && (
            <>
              <h2 className="mv-add__section" id="mv-import-skipped">{t('mobile.import.skipped')}</h2>
              <ul className="mv-import__list" aria-labelledby="mv-import-skipped">
                {result.skipped.map((s, i) => (
                  <li key={`${s.email}-${i}`}>
                    <span dir="auto">{s.email}</span>
                    <span className="mv-import__reason">{t(REASON_KEYS[s.reason] ?? 'mobile.import.reason.other')}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="mv-primary" onClick={() => onDone?.({ imported: result.imported })}>
            {t('common.done')}
          </button>
        </div>
      </section>
    );
  }

  if (step === 'password') {
    const canImport = !busy && [...password].length >= MIN_PASSWORD;
    return (
      <section className="mv-add mv-import" aria-labelledby="mv-import-title">
        <div className="mv-add__bar">
          <button type="button" className="mv-textbtn" disabled={busy} onClick={() => { setFrames(null); setPassword(''); setErrorCode(null); setStep('intro'); }}>
            {t('common.back')}
          </button>
        </div>
        <h1 id="mv-import-title" className="mv-add__title">{t('mobile.import.passwordTitle')}</h1>
        <p className="mv-add__lead">{t('mobile.import.passwordHint')}</p>
        <form className="mv-add__form" onSubmit={submit} noValidate>
          <div className="mv-field">
            <label className="mv-field__label" htmlFor="mv-import-password">{t('mobile.import.password')}</label>
            <div className="mv-import__secret">
              <input
                id="mv-import-password"
                className="mv-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="mv-textbtn" aria-controls="mv-import-password" onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? t('mobile.import.hide') : t('mobile.import.show')}
              </button>
            </div>
          </div>
          {errorCode && <p className="mv-add__error" role="alert">{t(ERROR_KEYS[errorCode] ?? 'mobile.import.failed')}</p>}
          {errorCode === 'INVALID' ? (
            <button type="button" className="mv-primary" onClick={startScan}>{t('mobile.import.scanAgain')}</button>
          ) : (
            <button type="submit" className="mv-primary" disabled={!canImport} aria-busy={busy}>
              {busy ? t('mobile.import.importing') : t('mobile.import.import')}
            </button>
          )}
        </form>
      </section>
    );
  }

  if (step === 'scanning') {
    return (
      <section className="mv-import-scan" aria-labelledby="mv-import-scan-title">
        <div className="mv-import-scan__frame" aria-hidden="true" />
        <div className="mv-import-scan__panel">
          <h1 id="mv-import-scan-title" className="mv-import-scan__title">{t('mobile.import.scanning')}</h1>
          {scanError ? (
            <>
              <p className="mv-add__error" role="alert">
                {t(scanError === 'denied' ? 'mobile.import.cameraDenied' : 'mobile.import.scanFailed')}
              </p>
              {scanError === 'denied' && (
                <button type="button" className="mv-primary" onClick={() => { openCameraSettings().catch(() => {}); }}>
                  {t('mobile.import.openSettings')}
                </button>
              )}
              <button type="button" className={scanError === 'denied' ? 'mv-textbtn' : 'mv-primary'} onClick={startScan}>
                {t('mobile.import.scanAgain')}
              </button>
            </>
          ) : (
            <p className="mv-import-scan__progress" role="status" aria-live="polite">
              {progress.total > 0 ? t('mobile.import.progress', { have: progress.have, total: progress.total }) : ''}
              {notOurs && <span className="mv-import-scan__hint">{t('mobile.import.notOurs')}</span>}
            </p>
          )}
          <button type="button" className="mv-textbtn" onClick={cancelScanning}>{t('common.cancel')}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="mv-add mv-import" aria-labelledby="mv-import-title">
      <div className="mv-add__bar">
        {onCancel && (
          <button type="button" className="mv-textbtn" onClick={onCancel}>{t('common.back')}</button>
        )}
      </div>
      <h1 id="mv-import-title" className="mv-add__title">{t('mobile.import.title')}</h1>
      <p className="mv-add__lead">{t('mobile.import.lead')}</p>
      <div className="mv-add__form">
        <ol className="mv-import__steps">
          <li>{t('mobile.import.step1')}</li>
          <li>{t('mobile.import.step2')}</li>
          <li>{t('mobile.import.step3')}</li>
        </ol>
        <div className="mv-import__shots">
          <img src={settingsShot} alt={t('mobile.import.shotSettings')} className="mv-import__shot" />
          <img src={qrShot} alt={t('mobile.import.shotQr')} className="mv-import__shot" />
        </div>
        <a className="mv-import__faq" href={importFaqUrl(getMobileLocale())} target="_blank" rel="noopener noreferrer">
          {t('mobile.import.faq')}
        </a>
        <button type="button" className="mv-primary" onClick={startScan}>{t('mobile.import.scan')}</button>
      </div>
    </section>
  );
}
