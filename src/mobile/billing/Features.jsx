// What Premium adds on the phone: the list the Billing component shows (the locked feature that
// opened the paywall highlighted) and the onboarding's Premium step shows too.
import React from 'react';
import { useT } from '../i18n.js';
import { PREMIUM_FEATURES } from '../premium.js';

/** What Premium adds on the phone; the onboarding's Premium step shows the same list. */
export default function Features({ highlight }) {
  const t = useT();
  return (
    <ul className="mv-premium__features">
      {PREMIUM_FEATURES.map((id) => (
        <li key={id} className="mv-premium__feature" data-mv-feature={id} data-mv-highlight={highlight === id ? 'true' : undefined} aria-current={highlight === id ? 'true' : undefined}>
          <span className="mv-premium__feature-title">{t(`mobile.premium.feature.${id}.title`)}</span>
          <span className="mv-premium__feature-blurb">{t(`mobile.premium.feature.${id}.blurb`)}</span>
        </li>
      ))}
    </ul>
  );
}

export { Features };
