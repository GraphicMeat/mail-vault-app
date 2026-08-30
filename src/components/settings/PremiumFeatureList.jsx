// src/components/settings/PremiumFeatureList.jsx
import React from 'react';
import { Check, Lock, ChevronRight } from 'lucide-react';
import { PREMIUM_FEATURES } from '../../data/premiumFeatures.js';
import { useT } from '../../i18n/index.js';

/**
 * What the subscription actually buys, in the one place someone goes to decide.
 *
 * Renders in every build, App Store included: a feature list carries no price
 * and is not a purchase path, so the MAS guards around the plan cards do not
 * apply here.
 */
export function PremiumFeatureList({ isPremium, onNavigate }) {
  const t = useT();

  return (
    <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
      <h4 className="text-sm font-semibold text-mail-text mb-3">{t('premium.list.title')}</h4>
      <ul className="space-y-1">
        {PREMIUM_FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <li
              key={f.id}
              data-testid={`premium-feature-${f.id}`}
              data-state={isPremium ? 'included' : 'locked'}
              className="flex items-start gap-3 py-2 border-b border-mail-border last:border-0"
            >
              <div className="w-7 h-7 rounded bg-mail-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon size={14} className="text-mail-accent-text" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-mail-text">{t(f.titleKey)}</span>
                  {isPremium
                    ? <Check size={13} className="text-mail-success flex-shrink-0" aria-label={t('premium.list.included')} />
                    : <Lock size={12} className="text-mail-text-muted flex-shrink-0" aria-label={t('premium.list.locked')} />}
                </div>
                <p className="text-xs text-mail-text-muted leading-snug">{t(f.blurbKey)}</p>
              </div>
              {f.tab && (
                <button
                  type="button"
                  onClick={() => onNavigate?.(f.tab)}
                  className="flex items-center gap-0.5 text-xs text-mail-accent-text hover:text-mail-accent-hover flex-shrink-0 mt-0.5"
                >
                  {t('common.open')}
                  <ChevronRight size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
