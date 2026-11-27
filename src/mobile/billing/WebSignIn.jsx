// "Bought on the website? Sign in": a website account's Premium on this phone, by its email and the
// mailed code (`mobile.premium.webSignIn.*`), so an account bought with Stripe logs in here. A
// sign-in that signed another device out says which one. Part of the Billing component.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT, getMobileLocale } from '../i18n.js';
import { errorKey } from '../errors.js';
import { Button } from '../../components/ui/Button.jsx';

const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';

export default function WebSignIn({ onDone }) {
  const t = useT();
  const [step, setStep] = useState('closed'); // closed | email | code | done
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null); // an error code
  const [replaced, setReplaced] = useState(null); // { clientName } or {}
  const [noPremium, setNoPremium] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await daemonCall('mobile.premium.webSignIn.start', { email: email.trim(), lang: getMobileLocale() });
      if (mounted.current) { setCode(''); setStep('code'); }
    } catch (err) {
      if (mounted.current) setProblem(err?.code ?? 'INTERNAL');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [email]);

  const verify = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const reply = await daemonCall('mobile.premium.webSignIn.verify', {
        email: email.trim(),
        code: code.trim(),
        ...(APP_VERSION ? { appVersion: APP_VERSION } : {}),
      });
      if (!mounted.current) return;
      if (reply?.premium) {
        setReplaced(reply.replacedClient ? { clientName: reply.replacedClient.clientName || '' } : null);
        setStep('done');
        onDone(reply); // before the store flips to "active", so this form stays to say who was signed out
      } else {
        setNoPremium(true);
      }
      useMobileStore.getState().setPremium(reply);
    } catch (err) {
      const c = err?.code ?? 'INTERNAL';
      if (mounted.current) {
        if (c === 'DEVICE_REPLACED') useMobileStore.getState().setPremiumLost('DEVICE_REPLACED');
        setProblem(c);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [email, code, onDone]);

  if (step === 'done') {
    return (
      <div className="mv-premium__web" role="status">
        <p>{t('mobile.premium.web.done')}</p>
        {replaced && (
          <p data-mv-replaced>
            {replaced.clientName
              ? t('mobile.premium.web.replaced', { name: replaced.clientName })
              : t('mobile.premium.web.replacedUnknown')}
          </p>
        )}
      </div>
    );
  }
  if (step === 'closed') {
    return (
      <Button variant="link" size="touch" fullWidth className="mt-5 justify-start mv-btn-flush" onClick={() => setStep('email')}>
        {t('mobile.premium.web.prompt')}
      </Button>
    );
  }
  // A code that can no longer be used (expired, spent, locked) asks for a new one.
  const needNewCode = problem === 'CODE_EXPIRED';
  return (
    <form
      className="mv-premium__web"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        if (step === 'email') start();
        else if (!needNewCode) verify();
      }}
    >
      {step === 'email' ? (
        <label className="mv-premium__field">
          <span>{t('mobile.premium.web.email')}</span>
          <input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      ) : (
        <>
          <p className="mv-premium__hint" dir="auto">{t('mobile.premium.web.codeSent', { email: email.trim() })}</p>
          <label className="mv-premium__field">
            <span>{t('mobile.premium.web.code')}</span>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </>
      )}
      {problem && <p className="mv-premium__error" role="alert">{t(errorKey(problem))}</p>}
      {noPremium && <p className="mv-premium__error" role="alert">{t('mobile.premium.web.noPremium')}</p>}
      <div className="mv-premium__row">
        <Button variant="link" size="touch" disabled={busy} onClick={() => { setStep('closed'); setProblem(null); setNoPremium(false); }}>
          {t('common.cancel')}
        </Button>
        {step === 'email' && (
          <Button variant="primary" size="touch" type="submit" disabled={busy || !email.includes('@')}>
            {busy ? t('mobile.premium.web.sending') : t('mobile.premium.web.sendCode')}
          </Button>
        )}
        {step === 'code' && needNewCode && (
          <Button variant="primary" size="touch" disabled={busy} onClick={start}>{t('mobile.premium.web.newCode')}</Button>
        )}
        {step === 'code' && !needNewCode && (
          <Button variant="primary" size="touch" type="submit" disabled={busy || !code.trim()}>
            {busy ? t('mobile.premium.web.verifying') : t('mobile.premium.web.verify')}
          </Button>
        )}
      </div>
    </form>
  );
}
