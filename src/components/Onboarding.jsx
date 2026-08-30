import React, { useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useAccountStore } from '../stores/accountStore';
import { onboardingSteps } from './onboarding/steps.js';
import { Splash } from './onboarding/Splash';
import { AccountStep } from './onboarding/AccountStep';
import { AppearanceStep } from './onboarding/AppearanceStep';
import { FreeFeatures } from './onboarding/FreeFeatures';
import { PremiumGallery } from './onboarding/PremiumGallery';
import { UpgradeCta } from './onboarding/UpgradeCta';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';

export function Onboarding({ onOpenBilling, onOpenFaq }) {
  const t = useT();
  // Accounts live in useAccountStore, not useSettingsStore — App.jsx:122 reads
  // them the same way. Only `onboardingComplete` is a setting.
  const accounts = useAccountStore(s => s.accounts) || [];
  const setOnboardingComplete = useSettingsStore(s => s.setOnboardingComplete);

  // Frozen at mount: adding the first account mid-flow must not renumber the
  // steps under the user's feet.
  const [steps] = useState(() => onboardingSteps(accounts.length));
  const [index, setIndex] = useState(0);

  const step = steps[index];
  const next = () => setIndex(i => Math.min(i + 1, steps.length - 1));
  const finish = () => setOnboardingComplete(true);

  return (
    <div className="h-screen bg-mail-bg flex items-center justify-center p-4 pt-8" data-testid={`onboarding-${step}`}>
      {step === 'splash' && <Splash onContinue={next} />}
      {step === 'account' && <AccountStep onAdded={next} />}
      {step === 'appearance' && <AppearanceStep onContinue={next} />}
      {step === 'free' && <FreeFeatures onContinue={next} />}
      {step === 'premium' && (
        <div className="max-w-3xl w-full">
          <h2 className="text-lg font-semibold text-mail-text mb-3">{t('onboarding.premiumTitle')}</h2>
          <PremiumGallery />
          <div className="flex justify-end mt-3">
            <Button variant="primary" size="lg" onClick={next} data-testid="onboarding-continue">
              {t('common.continue')}
            </Button>
          </div>
        </div>
      )}
      {step === 'cta' && (
        <UpgradeCta
          onUpgrade={() => { finish(); onOpenBilling?.(); }}
          onSkip={finish}
          onOpenFaq={onOpenFaq}
        />
      )}
    </div>
  );
}
