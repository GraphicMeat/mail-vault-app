// The paywall layer: a full-screen layer over everything (z above Settings), opened by a locked
// feature (`openPaywall(feature)` in premium.js, which marks that feature). It is only the frame, the
// header and Back: its content is the one Billing component (billing/Billing.jsx) that Settings >
// Billing shows too, so the user stays in context and sees the same plans, store prices, Restore,
// website sign-in and disclosures as in Settings.
import React from 'react';
import KeyboardLayer from './KeyboardLayer.jsx';
import { useT } from './i18n.js';
import { BackButton } from './icons.jsx';
import Billing from './billing/Billing.jsx';

export { Features } from './billing/Features.jsx';

export default function Premium({ feature = null, onClose }) {
  const t = useT();
  return (
    <KeyboardLayer as="section" className="mv-settings mv-shared-ui mv-premium" scroll=".mv-settings__body" role="dialog" aria-modal="true" aria-label={t('mobile.premium.title')}>
      <header className="mv-compose__bar">
        <BackButton onClick={onClose} />
        <h1 className="mv-compose__title">{t('mobile.premium.title')}</h1>
      </header>
      <div className="mv-settings__body settings-content mv-premium__body"><Billing feature={feature} /></div>
    </KeyboardLayer>
  );
}
