import React from 'react';
import { HelpCircle } from 'lucide-react';
import thankYouImage from '../../assets/onboarding/thank-you-mail-drawer-graphic-meat.webp';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';

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
 * No price and no checkout here — the button hands off to Settings → Billing,
 * which already owns plans, currency and the App Store rules. That is what lets
 * this screen ship identically in every build.
 */
export function UpgradeCta({ onUpgrade, onSkip, onOpenFaq }) {
  const t = useT();

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

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" fullWidth onClick={onUpgrade} data-testid="onboarding-upgrade">
          {t('onboarding.ctaPrimary')}
        </Button>
        <Button variant="ghost" size="md" fullWidth onClick={onSkip} data-testid="onboarding-skip">
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
