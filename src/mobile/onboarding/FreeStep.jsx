// What the phone app does for free, as the desktop's FreeFeatures does for the computer. Only what
// the phone really does: no vault, no files on a disk.
import React from 'react';
import { useT } from '../i18n.js';

export const FREE_FEATURES = ['accounts', 'direct', 'search', 'swipe'];

export default function FreeStep() {
  const t = useT();
  return (
    <>
      <h1 className="mv-tour__title">{t('onboarding.freeTitle')}</h1>
      <p className="mv-tour__lead">{t('onboarding.freeSubtitle')}</p>
      <ul className="mv-tour__features">
        {FREE_FEATURES.map((id) => (
          <li key={id} className="mv-tour__feature" data-testid={`free-feature-${id}`}>
            <span className="mv-tour__feature-title">{t(`mobile.onboarding.free.${id}.title`)}</span>
            <span className="mv-tour__feature-blurb">{t(`mobile.onboarding.free.${id}.blurb`)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
