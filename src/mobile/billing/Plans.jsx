// The plans a phone can buy, from the store: the two plans with the STORE's own price strings (from
// `mobile_store_products`; no amount is written in this code), Subscribe (IAP through `storePurchase`),
// Restore purchases (`storeRestore`), and the store's subscription disclosures: price and period per
// plan, that it renews until cancelled, how to cancel, and the Terms of Use and Privacy Policy links
// (plain https anchors: the shell's navigation guard hands them to the system browser).
// Never the web price, never a link to buy on the web, nothing that unlocks by sharing. The page
// never verifies a purchase itself: the shell hands the receipt to the engine, and the answer arrives
// here as the purchase's result and as `mobile.premium.changed`.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { storeProducts, storePurchase, storeRestore } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { errorKey } from '../errors.js';
import { MANAGE_URL, storeOf, introText } from '../premium.js';
import { Button } from '../../components/ui/Button.jsx';

const TERMS_URL = 'https://mailvaultapp.com/terms.html';
const PRIVACY_URL = 'https://mailvaultapp.com/privacy.html';

export default function Plans({ source = null }) {
  const t = useT();
  const [products, setProducts] = useState({ state: 'loading', list: [], code: null }); // loading | ready | failed
  const [chosen, setChosen] = useState(null);
  const [action, setAction] = useState(null); // 'buy' | 'restore' | null
  const [result, setResult] = useState(null); // { kind: 'thanks'|'pending'|'activating'|'restored'|'restoreNone'|'restoreInactive'|'notActive' } | { code }
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const store = storeOf(source);
  const storeName = t(`mobile.premium.source.${store}`);

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

  return (
    <div data-mv-plans>
      <h2 className="mv-settings__heading">{t('mobile.premium.plans')}</h2>
      {products.state === 'loading' && <p className="mv-premium__hint" role="status">{t('mobile.premium.products.loading')}</p>}
      {products.state === 'failed' && (
        <div>
          <p className="mv-premium__error" role="alert">{t(products.code === 'UNAVAILABLE' ? 'mobile.error.UNAVAILABLE' : 'mobile.premium.products.none')}</p>
          <Button variant="link" size="touch" onClick={loadProducts}>{t('common.retry')}</Button>
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
        <Button variant="primary" size="touch" disabled={!chosen || Boolean(action)} aria-busy={action === 'buy' || undefined} onClick={subscribe}>
          {action === 'buy' ? t('mobile.premium.subscribing') : t('mobile.premium.subscribe')}
        </Button>
        <Button variant="link" size="touch" disabled={Boolean(action)} aria-busy={action === 'restore' || undefined} onClick={restore}>
          {action === 'restore' ? t('mobile.premium.restoring') : t('mobile.premium.restore')}
        </Button>
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
    </div>
  );
}
