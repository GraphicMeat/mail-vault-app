import React from 'react';
import { Sparkles, HelpCircle } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';

/**
 * No price and no checkout here — the button hands off to Settings → Billing,
 * which already owns plans, currency and the App Store rules. That is what lets
 * this screen ship identically in every build.
 */
export function UpgradeCta({ onUpgrade, onSkip, onOpenFaq }) {
  const t = useT();

  return (
    <div className="max-w-md w-full text-center">
      <div className="w-12 h-12 rounded-xl bg-mail-accent/10 flex items-center justify-center mx-auto mb-3">
        <Sparkles size={22} className="text-mail-accent-text" />
      </div>
      <h2 className="text-lg font-semibold text-mail-text mb-1">{t('onboarding.ctaTitle')}</h2>
      <p className="text-sm text-mail-text-muted mb-5">{t('onboarding.ctaSubtitle')}</p>

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" fullWidth onClick={onUpgrade} data-testid="onboarding-upgrade">
          {t('onboarding.ctaPrimary')}
        </Button>
        <Button variant="ghost" size="sm" fullWidth onClick={onSkip} data-testid="onboarding-skip">
          {t('onboarding.ctaSkip')}
        </Button>
      </div>

      <button type="button" onClick={onOpenFaq} data-testid="onboarding-faq"
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-mail-text-muted hover:text-mail-accent-text">
        <HelpCircle size={13} />
        {t('onboarding.ctaFaq')}
      </button>
    </div>
  );
}
