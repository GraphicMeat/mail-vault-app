import React from 'react';
import { useT, t as tr } from '../../i18n/index.js';

/**
 * The plan to preselect: yearly (it carries the trial and the saving), else the
 * only plan there is. Null when the pricing answer holds none.
 */
export function defaultPlanId(plans) {
  const list = plans || [];
  return (list.find((p) => p.interval === 'year') || list[0])?.planId ?? null;
}

/** "Start Free Trial" on a trial-eligible yearly plan, "Upgrade" on anything else. */
export function planCtaLabel(plan) {
  return plan?.interval === 'year' && plan.trialEligible && plan.trialDays
    ? tr('settings.billing.startFreeTrial')
    : tr('common.upgrade');
}

/**
 * Yearly and monthly as one radio list, the choice every paywall shares
 * (onboarding and Settings → Billing). The price, the saving and the trial line
 * come from /api/billing/pricing as they are; the button that buys lives with
 * the caller, so one CTA serves the selected plan.
 */
export function PlanPicker({ plans, selectedId, onSelect, name = 'plan', label }) {
  const t = useT();
  const ordered = ['year', 'month'].map((interval) => (plans || []).find((p) => p.interval === interval)).filter(Boolean);
  return (
    <div role="radiogroup" aria-label={label} data-testid="plan-picker" className="flex flex-col gap-2 text-left">
      {ordered.map((plan) => {
        const yearly = plan.interval === 'year';
        const selected = plan.planId === selectedId;
        const trial = yearly && plan.trialEligible && plan.trialDays;
        return (
          <label key={plan.planId} data-testid={`plan-${plan.planId}`}
            className={`relative flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-mail-accent
              ${selected ? 'border-mail-accent bg-mail-accent-tint' : 'border-mail-border bg-mail-surface hover:border-mail-accent/60'}`}>
            <input type="radio" name={name} value={plan.planId} checked={selected}
              onChange={() => onSelect(plan.planId)} className="sr-only" />
            <span aria-hidden="true"
              className={`flex-shrink-0 w-4 h-4 rounded-full border-2 ${selected ? 'border-mail-accent bg-mail-accent-fill' : 'border-mail-border'}`} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-mail-text">{yearly ? t('settings.billing.yearly') : t('settings.billing.monthly')}</span>
              <span className="block text-xs text-mail-text-muted">
                {yearly
                  ? (trial
                    ? t('settings.billing.daysFreeThenMonth', { yearlyPlan: plan.trialDays, yearlyPlan2: plan.monthlyEquivalent })
                    : `~${plan.monthlyEquivalent}/month`)
                  : t('settings.billing.cancelAnytime')}
              </span>
            </span>
            {yearly && plan.savingsPercent > 0 && (
              <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-xs font-bold bg-mail-accent-fill text-white rounded-full">
                {t('settings.billing.savePercent', { percent: plan.savingsPercent })}
              </span>
            )}
            <span className="text-base font-bold text-mail-text whitespace-nowrap">
              {plan.formattedAmount}
              <span className="text-xs font-normal text-mail-text-muted">{yearly ? '/yr' : '/mo'}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
