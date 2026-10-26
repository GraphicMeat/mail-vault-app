import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import thankYouImage from '../../assets/onboarding/thank-you-mail-drawer-graphic-meat.webp';
import { useT } from '../../i18n/index.js';
import { PREMIUM_FEATURES } from '../../data/premiumFeatures.js';
import { fetchPricing } from '../../services/billingApi';
import { startCheckout } from '../../services/checkout';
import { useSettingsStore } from '../../stores/settingsStore';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { pricingRecord } from '../../utils/pricing';
import { PlanPicker, defaultPlanId, planCtaLabel } from '../billing/PlanPicker';
import { Button } from '../ui/Button';
import { ExternalLink } from '../ui/ExternalLink';
import { ReviewCards } from './ReviewCards';

// What Premium does, in the three features whose outcome is the easiest to
// picture: copies that happen on their own, a server that empties itself, a
// mailbox you can step back into. Titles and blurbs are the catalog's own.
const IMPACT_IDS = ['backup-schedule', 'auto-cleanup', 'time-capsule'];
const IMPACT = IMPACT_IDS.map((id) => PREMIUM_FEATURES.find((f) => f.id === id)).filter(Boolean);

const TERMS_URL = 'https://mailvaultapp.com/terms.html';
const PRIVACY_URL = 'https://mailvaultapp.com/privacy.html';

// A single burst from the illustration. Fixed positions keep repeat visits
// consistent and avoid timers or state updates for purely decorative motion.
const HEARTS = Array.from({ length: 44 }, (_, i) => {
  const angle = (i / 44) * Math.PI * 2 + Math.sin(i * 3.7) * 0.09;
  const reach = 22 + ((i * 17) % 37);
  return {
    x: `${(Math.cos(angle) * reach).toFixed(1)}vw`,
    y: `${(Math.sin(angle) * reach * 0.8).toFixed(1)}vh`,
    delay: `${(0.58 + (i % 6) * 0.045).toFixed(2)}s`,
    duration: `${(1.7 + (i % 5) * 0.17).toFixed(2)}s`,
    size: 14 + ((i * 7) % 14),
    rotation: `${((i * 47) % 100) - 50}deg`,
  };
});

/**
 * The thank-you step and the paywall in one screen: what people say, what
 * Premium does, the two plans, and one button that buys the chosen one.
 *
 * The App Store build never shows a price or a purchase path (Apple's rules),
 * so there the button hands off to Settings → Billing, which owns the IAP
 * flow. The same hand-off is the fallback when the plans cannot be loaded, so
 * the screen never has a dead end. In the direct build the checkout opens in
 * the browser and the user lands on Billing for the status check.
 *
 * Without `onUpgrade` (a subscriber, or no account to buy with) the one way on
 * is a plain Continue.
 */
export function UpgradeCta({ onUpgrade, onSkip, onOpenFaq, email }) {
  const t = useT();
  const sells = !!onUpgrade;
  const wantsPlans = sells && !IS_APPSTORE_BUILD && !!email;

  const [phase, setPhase] = useState(wantsPlans ? 'loading' : 'idle'); // loading | ready | failed | idle
  const [plans, setPlans] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!wantsPlans) return undefined;
    let live = true;
    fetchPricing({ email })
      .then((res) => {
        if (!live) return;
        if (!res?.plans?.length) { setPhase('failed'); return; }
        const record = pricingRecord(res);
        if (record) useSettingsStore.getState().setPremiumPricing(record);
        setPlans(res.plans);
        setSelectedId(defaultPlanId(res.plans));
        setPhase('ready');
      })
      .catch(() => { if (live) setPhase('failed'); });
    return () => { live = false; };
  }, [wantsPlans, email]);

  const selected = plans.find((p) => p.planId === selectedId);

  const checkout = async () => {
    if (busyRef.current || !selected) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await startCheckout({ email, planId: selected.planId });
    busyRef.current = false;
    if (result.ok) { onUpgrade(); return; }
    // The API answers 503 with a bare code and no prose (BillingSettings does
    // the same): a message with no space is a code, never shown as it is.
    setError(/\s/.test(result.error || '') ? result.error : t('settings.billing.billingServiceTemporarilyUnavailable'));
    setBusy(false);
  };

  return (
    <div className="max-w-md w-full text-center py-4">
      <div className="onboarding-thankyou-art mx-auto mb-5" aria-hidden="true">
        <img src={thankYouImage} alt="" width="1312" height="1199" className="onboarding-thankyou-image" />
        {HEARTS.map((heart, index) => (
          <span
            key={index}
            className="onboarding-flying-heart"
            style={{
              '--heart-x': heart.x,
              '--heart-y': heart.y,
              '--heart-delay': heart.delay,
              '--heart-duration': heart.duration,
              '--heart-rotation': heart.rotation,
            }}
          >
            <svg width={heart.size} height={heart.size} viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges">
              <path d="M2 2h4v2h4V2h4v2h2v5h-2v2h-2v2h-2v2H6v-2H4v-2H2V9H0V4h2V2z" />
            </svg>
          </span>
        ))}
      </div>
      <h2 className="text-2xl font-display font-bold text-mail-text mb-2">{t('onboarding.ctaTitle')}</h2>
      <p className="text-sm text-mail-text-muted leading-relaxed mb-6">{t('onboarding.ctaSubtitle')}</p>

      {sells && <ReviewCards />}

      {sells && (
        <section data-testid="onboarding-impact" className="mb-6 text-left">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-mail-text-muted mb-2 text-center">
            {t('onboarding.premiumTitle')}
          </h3>
          <ul className="flex flex-col gap-2">
            {IMPACT.map((feature) => {
              const Icon = feature.icon;
              return (
                <li key={feature.id} className="flex items-start gap-3">
                  <Icon size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-mail-accent-text" />
                  <span className="text-sm text-mail-text-muted leading-snug">
                    <span className="block font-semibold text-mail-text">{t(feature.titleKey)}</span>
                    {t(feature.blurbKey)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {phase === 'loading' && <div data-testid="onboarding-plans-loading" aria-busy="true" className="mb-4 min-h-[8rem]" />}

      {phase === 'ready' && (
        <div data-testid="onboarding-plans" className="mb-4">
          <PlanPicker plans={plans} selectedId={selectedId} onSelect={setSelectedId} name="onboarding-plan" label={t('onboarding.ctaPlans')} />
        </div>
      )}

      {error && <p role="alert" className="mb-3 text-xs text-mail-danger">{error}</p>}

      {/* Keyed so a button is the same button in every phase: React unwraps an
          unkeyed fragment and would reuse the loading phase's Continue with
          Free as See Premium the moment the plans fail, under a click. */}
      <div className="flex flex-col gap-2">
        {phase === 'ready' ? <>
          <Button key="primary" variant="primary" size="lg" fullWidth onClick={checkout} disabled={busy} data-testid="onboarding-checkout">
            {planCtaLabel(selected)}
          </Button>
          <Button key="skip" variant="ghost" size="md" fullWidth onClick={onSkip} data-testid="onboarding-skip">
            {t('onboarding.ctaSkip')}
          </Button>
        </> : onUpgrade && phase !== 'loading' ? <>
          <Button key="primary" variant="primary" size="lg" fullWidth onClick={onUpgrade} data-testid="onboarding-upgrade">
            {t('onboarding.ctaPrimary')}
          </Button>
          <Button key="skip" variant="ghost" size="md" fullWidth onClick={onSkip} data-testid="onboarding-skip">
            {t('onboarding.ctaSkip')}
          </Button>
        </> : onUpgrade ? <>
          {/* The primary button's slot, held empty while the plans load, so
              Continue with Free does not drop when it arrives. */}
          <div key="primary" aria-hidden="true" className="h-10" />
          <Button key="skip" variant="ghost" size="md" fullWidth onClick={onSkip} data-testid="onboarding-skip">
            {t('onboarding.ctaSkip')}
          </Button>
        </> : (
          <Button key="skip" variant="primary" size="lg" fullWidth onClick={onSkip} data-testid="onboarding-skip">
            {t('common.continue')}
          </Button>
        )}
      </div>

      {phase === 'ready' && (
        <div className="mt-4 flex items-center justify-center gap-x-4 gap-y-1 flex-wrap text-xs text-mail-text-muted">
          <button type="button" onClick={onUpgrade} data-testid="onboarding-restore" className="hover:text-mail-accent-text underline-offset-2 hover:underline">
            {t('onboarding.ctaRestore')}
          </button>
          <ExternalLink href={TERMS_URL} data-testid="onboarding-terms" className="hover:text-mail-accent-text hover:underline">
            {t('onboarding.ctaTerms')}
          </ExternalLink>
          <ExternalLink href={PRIVACY_URL} data-testid="onboarding-privacy" className="hover:text-mail-accent-text hover:underline">
            {t('settings.help.privacyPolicy')}
          </ExternalLink>
        </div>
      )}

      <button type="button" onClick={onOpenFaq} data-testid="onboarding-faq"
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-mail-text-muted hover:text-mail-accent-text">
        <HelpCircle size={13} />
        {t('onboarding.ctaFaq')}
      </button>
    </div>
  );
}
