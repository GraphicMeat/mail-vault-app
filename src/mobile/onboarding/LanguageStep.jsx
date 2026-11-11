// The tour's first screen: the language, asked for rather than sniffed (as on the desktop's
// Splash). A pick is stored in the engine (`language`, read before the next launch's first paint)
// and loaded at once: every `useT()` component re-renders in it, this screen included.
import React from 'react';
import { LOCALES } from '../../i18n/languages.js';
import { useT, getMobileLocale, loadMobileLocale } from '../i18n.js';
import { daemonCall } from '../transport.js';

export default function LanguageStep() {
  const t = useT();
  const active = getMobileLocale();

  const pick = (code) => {
    // A failed write still switches this run; the next launch then follows the system.
    daemonCall('mobile.settings.set', { language: code }).catch(() => {});
    return loadMobileLocale([code], code);
  };

  return (
    <>
      <h1 className="mv-tour__brand">
        <span className="mv-tour__brand-accent">{t('onboarding.mail')}</span>{t('onboarding.vault')}
      </h1>
      <p className="mv-tour__trust">{t('mobile.onboarding.trustLine')}</p>
      <h2 className="mv-tour__title">{t('mobile.onboarding.languageTitle')}</h2>
      <p className="mv-tour__lead">{t('mobile.onboarding.languageLead')}</p>
      <div role="radiogroup" aria-label={t('settings.language.title')} className="mv-tour__languages">
        {LOCALES.map((l) => {
          const selected = l.code === active;
          return (
            <button
              key={l.code}
              type="button"
              role="radio"
              aria-checked={selected}
              lang={l.code}
              data-testid={`onboarding-language-${l.code}`}
              className="mv-tour__language"
              onClick={() => pick(l.code)}
            >
              <span className="mv-tour__flag" aria-hidden="true">{l.flag}</span>
              <span className="mv-tour__native">{l.native}</span>
              {selected && (
                <svg className="mv-tour__check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
