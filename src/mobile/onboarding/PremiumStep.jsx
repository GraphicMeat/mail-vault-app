// What Premium adds on the phone: the Premium screen's own list (Premium.jsx), and nothing to buy
// here. The plans are in Settings > Premium.
import React from 'react';
import { useT } from '../i18n.js';
import { Features } from '../Premium.jsx';

export default function PremiumStep() {
  const t = useT();
  return (
    <>
      <h1 className="mv-tour__title">{t('onboarding.premiumTitle')}</h1>
      <p className="mv-tour__lead">{t('mobile.onboarding.premiumLead')}</p>
      <Features highlight={null} />
    </>
  );
}
