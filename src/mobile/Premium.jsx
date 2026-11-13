// The Premium screen: a full-screen layer over everything (z above Settings), opened from Settings
// or by a locked feature (`openPaywall(feature)` in premium.js, which highlights that feature).
//
// - What Premium adds on the phone, the two plans with the STORE's own price strings (from
//   `mobile_store_products`; no amount is written in this code), Subscribe, Restore purchases.
// - The store's subscription disclosures, shown with the plans: price and period per plan, that it
//   renews until cancelled, how to cancel, and the Terms of Use and Privacy Policy links. Links are
//   plain https anchors: the shell's navigation guard hands them to the system browser.
// - "Already have Premium from the MailVault website? Sign in": email, then the mailed code. A
//   sign-in that signed another device out says which one.
// - Never the web price, never a link to buy on the web, nothing that unlocks by sharing.
// The page never verifies a purchase itself: the shell hands the receipt to the engine, and the
// answer arrives here as the purchase's result and as `mobile.premium.changed`.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall, storeProducts, storePurchase, storeRestore } from './transport.js';
import { useMobileStore } from './store.js';
import KeyboardLayer from './KeyboardLayer.jsx';
import { useT, getMobileLocale } from './i18n.js';
import { errorKey } from './errors.js';
import { PREMIUM_FEATURES, storeOf, premiumSummary, introText } from './premium.js';

const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';
const TERMS_URL = 'https://mailvaultapp.com/terms.html';
const PRIVACY_URL = 'https://mailvaultapp.com/privacy.html';
const MANAGE_URL = {
  apple: 'https://apps.apple.com/account/subscriptions',
  google: 'https://play.google.com/store/account/subscriptions',
};

/** What Premium adds on the phone; the onboarding's Premium step shows the same list. */
export function Features({ highlight }) {
  const t = useT();
  return (
    <ul className="mv-premium__features">
      {PREMIUM_FEATURES.map((id) => (
        <li key={id} className="mv-premium__feature" data-mv-feature={id} data-mv-highlight={highlight === id ? 'true' : undefined} aria-current={highlight === id ? 'true' : undefined}>
          <span className="mv-premium__feature-title">{t(`mobile.premium.feature.${id}.title`)}</span>
          <span className="mv-premium__feature-blurb">{t(`mobile.premium.feature.${id}.blurb`)}</span>
        </li>
      ))}
    </ul>
  );
}

function WebSignIn({ startOpen, onDone }) {
  const t = useT();
  const [step, setStep] = useState(startOpen ? 'email' : 'closed'); // closed | email | code | done
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
      <button type="button" className="mv-premium__linkbtn" onClick={() => setStep('email')}>
        {t('mobile.premium.web.prompt')}
      </button>
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
        <button type="button" className="mv-textbtn" disabled={busy} onClick={() => { setStep('closed'); setProblem(null); setNoPremium(false); }}>
          {t('common.cancel')}
        </button>
        {step === 'email' && (
          <button type="submit" className="mv-premium__primary" disabled={busy || !email.includes('@')}>
            {busy ? t('mobile.premium.web.sending') : t('mobile.premium.web.sendCode')}
          </button>
        )}
        {step === 'code' && needNewCode && (
          <button type="button" className="mv-premium__primary" disabled={busy} onClick={start}>{t('mobile.premium.web.newCode')}</button>
        )}
        {step === 'code' && !needNewCode && (
          <button type="submit" className="mv-premium__primary" disabled={busy || !code.trim()}>
            {busy ? t('mobile.premium.web.verifying') : t('mobile.premium.web.verify')}
          </button>
        )}
      </div>
    </form>
  );
}

export default function Premium({ feature = null, signIn = false, onClose }) {
  const t = useT();
  const premium = useMobileStore((s) => s.premium);
  const lost = useMobileStore((s) => s.premiumLost);
  const lapsed = useMobileStore((s) => s.premiumLapsed);
  const [products, setProducts] = useState({ state: 'loading', list: [], code: null }); // loading | ready | failed
  const [chosen, setChosen] = useState(null);
  const [webDone, setWebDone] = useState(false); // a website sign-in just turned Premium on
  const [signOuts, setSignOuts] = useState(0); // a sign-out starts the website form afresh
  const [action, setAction] = useState(null); // 'buy' | 'restore' | null
  const [result, setResult] = useState(null); // { kind: 'thanks'|'pending'|'activating'|'restored'|'restoreNone'|'restoreInactive' } | { code }
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const store = storeOf(premium.source);

  const loadProducts = useCallback(() => {
    setProducts({ state: 'loading', list: [], code: null });
    storeProducts().then(
      (list) => {
        if (!mounted.current) return;
        setProducts({ state: 'ready', list, code: null });
        // The yearly plan is offered first when the store has it; the user can switch.
        setChosen((cur) => cur ?? (list.find((p) => p.period === 'P1Y') ?? list[0])?.id ?? null);
      },
      (err) => { if (mounted.current) setProducts({ state: 'failed', list: [], code: err?.code ?? 'INTERNAL' }); },
    );
  }, []);
  useEffect(() => { loadProducts(); }, [loadProducts]);

  const subscribe = useCallback(async () => {
    if (!chosen || action) return;
    setAction('buy');
    setResult(null);
    try {
      const out = await storePurchase(chosen);
      if (!mounted.current) return;
      if (out.status === 'cancelled') {
        setResult(null);
      } else if (out.status === 'pending') {
        setResult({ kind: 'pending' });
      } else if (out.premium?.premium) {
        useMobileStore.getState().setPremium(out.premium);
        setResult({ kind: 'thanks' });
      } else if (out.premium) {
        // The server read the receipt and said it is not active (expired, refunded): no thanks.
        useMobileStore.getState().setPremium(out.premium);
        setResult({ kind: 'notActive' });
      } else if (out.error && (out.error.code === 'NETWORK' || out.error.code === 'RATE_LIMITED')) {
        // Paid: the engine checks it again at the next launch.
        setResult({ kind: 'activating' });
      } else {
        setResult({ code: out.error?.code ?? 'INTERNAL' });
      }
    } catch (err) {
      if (mounted.current) setResult({ code: err?.code ?? 'INTERNAL' });
    } finally {
      if (mounted.current) setAction(null);
    }
  }, [chosen, action]);

  const restore = useCallback(async () => {
    if (action) return;
    setAction('restore');
    setResult(null);
    try {
      const items = await storeRestore();
      if (!mounted.current) return;
      const on = items.find((i) => i.premium?.premium);
      if (on) {
        useMobileStore.getState().setPremium(on.premium);
        setResult({ kind: 'restored' });
      } else if (items.length === 0) {
        setResult({ kind: 'restoreNone' });
      } else {
        const failed = items.find((i) => i.error);
        setResult(failed ? { code: failed.error.code } : { kind: 'restoreInactive' });
      }
    } catch (err) {
      if (mounted.current) setResult({ code: err?.code ?? 'INTERNAL' });
    } finally {
      if (mounted.current) setAction(null);
    }
  }, [action]);

  const signOut = useCallback(async () => {
    if (action) return;
    setAction('signOut');
    setResult(null);
    try {
      const reply = await daemonCall('mobile.premium.webSignOut', {});
      if (!mounted.current) return;
      setWebDone(false);
      setSignOuts((n) => n + 1);
      useMobileStore.getState().setPremium(reply);
    } catch (err) {
      if (mounted.current) setResult({ code: err?.code ?? 'INTERNAL' });
    } finally {
      if (mounted.current) setAction(null);
    }
  }, [action]);

  const active = premium.premium;
  const storeName = t(`mobile.premium.source.${store}`);
  const body = (
    <>
      {!active && <p className="mv-premium__lead">{t('mobile.premium.heading')}</p>}
      <Features highlight={feature} />

      {lost === 'DEVICE_REPLACED' && !active && (
        <p className="mv-premium__error" role="alert" data-mv-lost>{t('mobile.premium.deviceReplaced')}</p>
      )}
      {lapsed && !active && lost !== 'DEVICE_REPLACED' && (
        <p className="mv-premium__note" role="status" data-mv-lapsed>{t('mobile.premium.lapsed')}</p>
      )}

      {active ? (
        <>
          <p className="mv-premium__status" role="status">{premiumSummary(premium)}</p>
          {(premium.source === 'apple' || premium.source === 'google') && (
            <p className="mv-premium__hint">
              {t('mobile.premium.manageHint', { store: t(`mobile.premium.source.${premium.source}`) })}{' '}
              <a href={MANAGE_URL[premium.source]} target="_blank" rel="noopener noreferrer">{t('mobile.premium.manage')}</a>
            </p>
          )}
          {premium.source === 'web' && (
            // Releases this phone's place among the account's devices.
            <button type="button" className="mv-premium__linkbtn" data-mv-web-sign-out disabled={Boolean(action)} onClick={signOut}>
              {t('mobile.premium.web.signOut')}
            </button>
          )}
          {result?.code && <p className="mv-premium__error" role="alert">{t(errorKey(result.code))}</p>}
        </>
      ) : (
        <>
          <h2 className="mv-settings__heading">{t('mobile.premium.plans')}</h2>
          {products.state === 'loading' && <p className="mv-premium__hint" role="status">{t('mobile.premium.products.loading')}</p>}
          {products.state === 'failed' && (
            <div>
              <p className="mv-premium__error" role="alert">{t(products.code === 'UNAVAILABLE' ? 'mobile.error.UNAVAILABLE' : 'mobile.premium.products.none')}</p>
              <button type="button" className="mv-textbtn" onClick={loadProducts}>{t('common.retry')}</button>
            </div>
          )}
          {products.state === 'ready' && products.list.length === 0 && (
            <p className="mv-premium__error" role="alert">{t('mobile.premium.products.none')}</p>
          )}
          {products.state === 'ready' && products.list.length > 0 && (
            <div role="radiogroup" aria-label={t('mobile.premium.plans')} className="mv-premium__plans">
              {products.list.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen === p.id}
                  className="mv-premium__plan"
                  data-mv-plan={p.period}
                  disabled={Boolean(action)}
                  onClick={() => setChosen(p.id)}
                >
                  <span className="mv-premium__plan-name">{p.period === 'P1Y' ? t('mobile.premium.plan.year') : t('mobile.premium.plan.month')}</span>
                  <span className="mv-premium__plan-price">{t(p.period === 'P1Y' ? 'mobile.premium.perYear' : 'mobile.premium.perMonth', { price: p.price })}</span>
                  {p.introOffer && <span className="mv-premium__plan-intro">{introText(p.introOffer)}</span>}
                </button>
              ))}
            </div>
          )}
          <div className="mv-premium__row mv-premium__row--stack">
            <button type="button" className="mv-premium__primary" disabled={!chosen || Boolean(action)} aria-busy={action === 'buy' || undefined} onClick={subscribe}>
              {action === 'buy' ? t('mobile.premium.subscribing') : t('mobile.premium.subscribe')}
            </button>
            <button type="button" className="mv-textbtn" disabled={Boolean(action)} aria-busy={action === 'restore' || undefined} onClick={restore}>
              {action === 'restore' ? t('mobile.premium.restoring') : t('mobile.premium.restore')}
            </button>
          </div>
          {result?.kind && <p className="mv-premium__note" role="status">{t(`mobile.premium.result.${result.kind}`)}</p>}
          {result?.code && <p className="mv-premium__error" role="alert">{t(errorKey(result.code))}</p>}

          <div className="mv-premium__disclosure" data-mv-disclosure>
            <p>{t('mobile.premium.disclosure.renew')}</p>
            <p>{t('mobile.premium.disclosure.charge', { store: storeName })}</p>
            {/* Each store's own rule: Apple stops the next charge only 24 hours ahead, Play any time. */}
            <p>{t(store === 'google' ? 'mobile.premium.disclosure.cancelGoogle' : 'mobile.premium.disclosure.cancelApple', { store: storeName })}</p>
            <p>
              <a href={MANAGE_URL[store]} target="_blank" rel="noopener noreferrer">{t('mobile.premium.manage')}</a>
            </p>
            <p className="mv-premium__legal">
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">{t('mobile.premium.terms')}</a>
              <span aria-hidden="true"> · </span>
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">{t('mobile.premium.privacy')}</a>
            </p>
          </div>
        </>
      )}

      {(!active || webDone) && <WebSignIn key={signOuts} startOpen={signIn} onDone={() => { setResult(null); setWebDone(true); }} />}
    </>
  );

  return (
    <KeyboardLayer as="section" className="mv-settings mv-premium" scroll=".mv-settings__body" role="dialog" aria-modal="true" aria-label={t('mobile.premium.title')} data-mv-sign-in={signIn ? 'true' : undefined}>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" onClick={onClose}>{t('common.back')}</button>
        <h1 className="mv-compose__title">{t('mobile.premium.title')}</h1>
      </header>
      <div className="mv-settings__body mv-premium__body">{body}</div>
    </KeyboardLayer>
  );
}
