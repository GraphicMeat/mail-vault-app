import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useT } from '../../i18n/index.js';
import { Private } from '../privacy/Private';
import { phoneQr } from '../../services/workflows/transferAccounts';
import { transferErrorKey, TRANSFER_PASSWORD_MIN } from '../../services/transfer/transferErrors';
import { TRANSFER_INPUT } from './transferStyles';

/** How long each frame of a multi-part code stays on screen. */
export const PHONE_QR_FRAME_MS = 1000;
/** The code hides itself after this long; showing it again needs the password. */
export const PHONE_QR_HIDE_MS = 5 * 60 * 1000;

function SkipReason({ reason }) {
  const t = useT();
  switch (reason) {
    case 'no-secret': return t('settings.phoneSetup.skip.noSecret');
    case 'unsupported-provider': return t('settings.phoneSetup.skip.unsupportedProvider');
    case 'custom-oauth-client': return t('settings.phoneSetup.skip.customOauthClient');
    case 'jmap-login': return t('settings.phoneSetup.skip.jmapLogin');
    default: return t('settings.phoneSetup.skip.invalid');
  }
}

const svgSrc = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * Set up the mobile app: every account, sealed with a password the user picks
 * here, shown as a QR code the phone scans (several frames cycling once a
 * second when it does not fit one). The daemon does the mapping, the crypto
 * and the rendering (`transfer.phone_qr`). Rendered by App.jsx in the MAIN
 * window only, like ExportModal: phoneQr reads accounts through getAccounts.
 * Mounted only while open, so closing drops the password and the code.
 */
export function PhoneQrModal({ onClose }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null); // { frames: [svg], skipped: [{ email, reason }] }
  const [frame, setFrame] = useState(0);
  const [hidden, setHidden] = useState(false);

  const mismatch = confirm !== '' && password !== confirm;
  const ready = [...password].length >= TRANSFER_PASSWORD_MIN && password === confirm;
  const total = code?.frames.length ?? 0;

  useEffect(() => {
    if (total < 2) return undefined;
    const timer = setInterval(() => setFrame(i => (i + 1) % total), PHONE_QR_FRAME_MS);
    return () => clearInterval(timer);
  }, [total, code]);

  useEffect(() => {
    if (!total) return undefined;
    const timer = setTimeout(() => {
      setCode(null);
      setHidden(true);
    }, PHONE_QR_HIDE_MS);
    return () => clearTimeout(timer);
  }, [total, code]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setHidden(false);
    try {
      const reply = await phoneQr({ password });
      setPassword('');
      setConfirm('');
      setFrame(0);
      setCode({ frames: reply?.frames || [], skipped: reply?.skipped || [] });
    } catch (err) {
      setError(transferErrorKey(err));
    } finally {
      setBusy(false);
    }
  };

  const skippedList = code?.skipped.length > 0 && (
    <div>
      <p className="text-xs font-medium text-mail-text-muted mb-1">{t('settings.phoneSetup.skippedTitle')}</p>
      <ul className="space-y-1 text-xs text-mail-text-muted">
        {code.skipped.map((s, i) => (
          <li key={`${s.email}-${i}`} className="flex flex-wrap gap-x-2">
            <span className="text-mail-text"><Private kind="email">{s.email}</Private></span>
            <span><SkipReason reason={s.reason} /></span>
          </li>
        ))}
      </ul>
    </div>
  );

  const footer = code
    ? <div className="flex justify-end w-full"><Button variant="primary" size="sm" onClick={onClose}>{t('common.close')}</Button></div>
    : <div className="flex justify-end gap-2 w-full">
      <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
      <Button variant="primary" size="sm" onClick={run} disabled={!ready || busy} loading={busy}>
        {busy ? t('settings.transfer.encrypting') : t('settings.phoneSetup.generate')}
      </Button>
    </div>;

  return (
    <Dialog open onClose={onClose} dismissable={!busy} portal title={t('settings.phoneSetup.title')} footer={footer}>
      {code && total > 0 && <>
        <div className="flex flex-col items-center gap-2">
          {/* Always black on white: phone scanners fail on a dark-mode code. */}
          <div className="bg-white rounded-lg p-2">
            <img src={svgSrc(code.frames[frame])} alt={t('settings.phoneSetup.qrAlt')} width={280} height={280} className="block" />
          </div>
          {total > 1 && (
            <p className="text-xs text-mail-text-muted" aria-live="off">
              {t('settings.phoneSetup.part', { index: frame + 1, total })}
            </p>
          )}
        </div>
        <ol className="list-decimal pl-5 space-y-1 text-sm text-mail-text">
          <li>{t('settings.phoneSetup.step1')}</li>
          <li>{t('settings.phoneSetup.step2')}</li>
          <li>{t('settings.phoneSetup.step3')}</li>
        </ol>
        <p className="flex items-start gap-2 text-xs text-mail-text-muted">
          <AlertTriangle size={14} aria-hidden="true" className="text-mail-warning flex-shrink-0 mt-0.5" />
          {t('settings.phoneSetup.warning')}
        </p>
        {skippedList}
      </>}
      {code && total === 0 && <>
        <p role="status" className="text-sm text-mail-text">{t('settings.phoneSetup.nothing')}</p>
        {skippedList}
      </>}
      {!code && <>
        <p className="text-sm text-mail-text-muted">{t('settings.phoneSetup.intro')}</p>
        {hidden && <p role="status" className="text-sm text-mail-text">{t('settings.phoneSetup.hidden')}</p>}
        <div>
          <label htmlFor="phone-qr-password" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.password')}</label>
          <input id="phone-qr-password" type="password" autoComplete="new-password" data-autofocus className={TRANSFER_INPUT}
            value={password} onChange={e => setPassword(e.target.value)} aria-describedby="phone-qr-hint" />
          <p id="phone-qr-hint" className="text-xs text-mail-text-muted mt-1">{t('settings.transfer.passwordHint', { count: TRANSFER_PASSWORD_MIN })}</p>
        </div>
        <div>
          <label htmlFor="phone-qr-confirm" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.confirmPassword')}</label>
          <input id="phone-qr-confirm" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
            value={confirm} onChange={e => setConfirm(e.target.value)} aria-invalid={mismatch || undefined} />
          {mismatch && <p className="text-xs text-mail-danger mt-1">{t('settings.transfer.passwordMismatch')}</p>}
        </div>
        {error && <p role="alert" className="text-sm text-mail-danger">{t(error.key, error.values)}</p>}
      </>}
    </Dialog>
  );
}
