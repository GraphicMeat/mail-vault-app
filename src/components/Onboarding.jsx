import React, { useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useAccountStore } from '../stores/accountStore';
import { onboardingSteps } from './onboarding/steps.js';
import { Splash } from './onboarding/Splash';

export function Onboarding({ onOpenBilling }) {
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
      {step === 'account' && <div>account<button onClick={next}>continue</button></div>}
      {step === 'appearance' && <div>appearance<button onClick={next}>continue</button></div>}
      {step === 'free' && <div>free<button onClick={next}>continue</button></div>}
      {step === 'premium' && <div>premium<button onClick={next}>continue</button></div>}
      {step === 'cta' && (
        <div>
          cta
          <button onClick={() => { finish(); onOpenBilling?.(); }}>upgrade</button>
          <button onClick={finish}>later</button>
        </div>
      )}
    </div>
  );
}
