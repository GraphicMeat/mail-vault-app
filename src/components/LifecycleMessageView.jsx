import React, { useEffect } from 'react';
import { Sparkles, Star, X } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useSettingsStore } from '../stores/settingsStore';
import { useLifecycleStore, lifecycleKeys } from '../stores/lifecycleStore';
import { formatDateLong, formatEmailDate } from '../utils/dateFormat';
import { Button } from './ui/Button';
import { ensurePremiumPricing } from '../hooks/usePremiumPricing.js';
import { premiumOffer } from '../utils/pricing';
import backupsArt from '../assets/lifecycle/backups.webp';
import cleanupArt from '../assets/lifecycle/cleanup.webp';
import privacyArt from '../assets/lifecycle/privacy.webp';
import archiveArt from '../assets/lifecycle/archive.webp';

const GITHUB_URL = 'https://github.com/GraphicMeat/mail-vault-app';

// What Premium is for, told as scenes rather than a feature list. The first
// is the hero; the rest sit side by side.
const SCENES = [
  { id: 'backups', art: backupsArt },
  { id: 'cleanup', art: cleanupArt },
  { id: 'privacy', art: privacyArt },
];

function Scene({ id, art, hero }) {
  const t = useT();
  return (
    <li data-testid="lifecycle-scene" data-scene={id}
      className={`overflow-hidden rounded-xl border border-mail-border bg-mail-surface ${hero ? 'sm:col-span-2' : ''}`}>
      <img src={art} alt="" aria-hidden="true" decoding="async"
        className={`block w-full object-cover bg-[#141018] ${hero ? 'aspect-[16/8]' : 'aspect-video'}`} />
      <div className="px-4 py-3">
        <h3 className="text-sm font-semibold text-mail-text">{t(`lifecycle.freeNudge.scene.${id}.title`)}</h3>
        <p className="mt-1 text-xs text-mail-text-muted leading-relaxed">{t(`lifecycle.freeNudge.scene.${id}.blurb`)}</p>
      </div>
    </li>
  );
}

/**
 * One plan as a button, the way the website's pricing cards read: the price in
 * the currency checkout bills and, while early access sells it below the
 * standard price, that price struck beside it with the discount.
 */
function PlanButton({ plan, best, title, sub, priceKey, onChoose }) {
  const t = useT();
  return (
    <button type="button" data-testid={`lifecycle-plan-${plan.planId}`} onClick={() => onChoose(plan.planId)}
      className={`relative flex items-center gap-3 w-full text-left rounded-xl border px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mail-accent
        ${best ? 'border-mail-accent bg-mail-accent-tint hover:bg-mail-accent/20' : 'border-mail-border bg-mail-bg hover:border-mail-accent/60'}`}>
      {best && (
        <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[11px] font-bold bg-mail-accent-fill text-white rounded-full">
          {t('lifecycle.freeNudge.offer.bestOffer')}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-mail-text">{title}</span>
        {sub && <span className="block text-xs text-mail-text-muted">{sub}</span>}
      </span>
      <span className="flex flex-col items-end">
        <span className="text-base font-bold text-mail-text whitespace-nowrap">{t(priceKey, { price: plan.price })}</span>
        {plan.off > 0 && (
          <span className="flex items-baseline gap-1.5 text-xs whitespace-nowrap">
            <s className="text-mail-text-muted">{plan.standard}</s>
            <span className="font-semibold text-mail-accent-text">{t('lifecycle.freeNudge.offer.off', { percent: plan.off })}</span>
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The offer: while early access sells below the standard price, a limited offer
 * for early users and the people close to them. Yearly (the trial and the
 * bigger saving) is the best offer; each plan is its own button and opens
 * Billing with that plan chosen, where the account to buy with is picked.
 */
function Offer({ onChoose }) {
  const t = useT();
  const pricing = useSettingsStore((s) => s.premiumPricing);
  useEffect(() => { ensurePremiumPricing(); }, []);
  const { limited, trialDays, yearly, monthly } = premiumOffer(pricing);
  // Same words as the Billing tab: outside USD, GBP and EUR the price is the
  // EUR base, converted (adaptive) or charged as is (fallback).
  const mode = pricing?.pricingMode;
  const currencyNote = mode === 'adaptive'
    ? t('settings.billing.pricesShownCheckoutConvertLocal', { pricing: pricing.currency.toUpperCase() })
    : mode === 'fallback'
      ? t('settings.billing.charged', { pricing: pricing.currency.toUpperCase() })
      : null;
  return (
    <div data-testid="lifecycle-offer" className="mt-5 p-4 rounded-xl border border-mail-accent/30 bg-mail-surface">
      {limited && (
        <>
          <p className="text-sm font-semibold text-mail-text">{t('lifecycle.freeNudge.offer.title')}</p>
          <p className="mt-1 text-xs text-mail-text-muted leading-relaxed">{t('lifecycle.freeNudge.offer.blurb')}</p>
        </>
      )}
      <div className={`flex flex-col gap-3 ${limited ? 'mt-5' : ''}`}>
        <PlanButton plan={yearly} best onChoose={onChoose} priceKey="lifecycle.freeNudge.offer.perYear"
          title={trialDays ? t('lifecycle.freeNudge.cta') : t('settings.billing.yearly')}
          sub={trialDays ? t('lifecycle.freeNudge.offer.trialDays', { days: trialDays }) : null} />
        <PlanButton plan={monthly} onChoose={onChoose} priceKey="lifecycle.freeNudge.offer.perMonth"
          title={t('settings.billing.monthly')} sub={t('settings.billing.cancelAnytime')} />
      </div>
      {currencyNote && (
        <p data-testid="lifecycle-offer-currency" className="mt-2 text-xs text-mail-text-muted">{currencyNote}</p>
      )}
    </div>
  );
}

/**
 * The reader's view of one lifecycle message: laid out like a mail (from,
 * subject, date, text) so it reads as a note from MailVault, and labelled as
 * what it is. It was written by the app on this computer; nothing was sent.
 */
export function LifecycleMessageView({ onOpenBilling }) {
  const t = useT();
  const row = useLifecycleStore((s) => s.rows.find((r) => r.id === s.openId));
  const periodEnd = useSettingsStore((s) => s.billingProfile?.currentPeriodEnd);
  const keys = row && lifecycleKeys(row.kind);
  if (!row || !keys) return null;

  const body = t(keys.bodyKey, { date: periodEnd ? formatDateLong(periodEnd) : '' });

  return (
    <div data-testid="lifecycle-message" className="flex-1 min-h-0 overflow-y-auto bg-mail-bg">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-mail-accent-tint text-mail-accent-text flex items-center justify-center">
            <Sparkles size={16} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-mail-text leading-snug">{t(keys.subjectKey)}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-mail-text-muted">
              <span data-testid="lifecycle-message-from" className="font-medium text-mail-text">{t('lifecycle.from')}</span>
              <span data-testid="lifecycle-message-date" className="ml-auto whitespace-nowrap">
                {formatEmailDate(new Date(row.atMs).toISOString())}
              </span>
            </div>
          </div>
          <button type="button" data-testid="lifecycle-message-close"
            aria-label={t('common.close')} title={t('common.close')}
            onClick={() => useLifecycleStore.getState().close()}
            className="flex-shrink-0 p-1 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-border">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p data-testid="lifecycle-message-body" className="text-sm text-mail-text leading-relaxed whitespace-pre-line">{body}</p>

        {keys.vision && (
          <>
            <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {SCENES.map((s, i) => <Scene key={s.id} {...s} hero={i === 0} />)}
            </ul>

            <div data-testid="lifecycle-free-feature"
              className="mt-3 flex items-center gap-4 p-3 rounded-xl border border-dashed border-mail-border">
              <img src={archiveArt} alt="" aria-hidden="true" decoding="async"
                className="flex-shrink-0 w-28 aspect-[16/10] rounded-lg object-cover bg-[#141018]" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-mail-text">
                  {t('lifecycle.freeNudge.freeTitle')}
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-mail-border text-mail-text-muted">
                    {t('lifecycle.freeBadge')}
                  </span>
                </div>
                <p className="mt-1 text-xs text-mail-text-muted leading-relaxed">{t('lifecycle.freeNudge.freeBlurb')}</p>
              </div>
            </div>
          </>
        )}


        {keys.outroKey && (
          <p data-testid="lifecycle-message-outro" className="mt-5 text-sm text-mail-text leading-relaxed">{t(keys.outroKey)}</p>
        )}

        {keys.vision ? (
          <Offer onChoose={(planId) => { useSettingsStore.getState().chooseBillingPlan(planId); onOpenBilling?.(); }} />
        ) : (
          <div className="mt-6">
            <Button variant="primary" size="md" onClick={onOpenBilling} data-testid="lifecycle-open-billing">
              {t(keys.ctaKey)}
            </Button>
          </div>
        )}

        {keys.vision && (
          <div data-testid="lifecycle-star" className="mt-6 flex items-start gap-3 p-4 rounded-xl bg-mail-surface border border-mail-border">
            <Star size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-amber-400 fill-amber-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-mail-text">{t('lifecycle.freeNudge.star.title')}</p>
              <p className="mt-1 text-xs text-mail-text-muted leading-relaxed">{t('lifecycle.freeNudge.star.blurb')}</p>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" data-testid="lifecycle-star-link"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-mail-accent-text hover:underline">
                <Star size={12} aria-hidden="true" />
                {t('lifecycle.freeNudge.star.link')}
              </a>
            </div>
          </div>
        )}

        <p data-testid="lifecycle-message-footer" className="mt-8 pt-4 border-t border-mail-border text-xs text-mail-text-muted leading-relaxed">
          {t('lifecycle.footer')}
        </p>
      </div>
    </div>
  );
}
