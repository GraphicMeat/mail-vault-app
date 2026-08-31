import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Check } from 'lucide-react';
import logoUrl from '../../assets/graphicmeat-logo.webp';
import { LOCALES, setLocale, useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/Button';

/**
 * First run, first screen.
 *
 * The language is asked for here rather than sniffed from the OS — the
 * standing rule is that a machine-translated UI appearing unasked-for is a
 * worse first impression than English. Asking is not sniffing, and it finally
 * gives the eight translated locales a front door.
 *
 * No auto-advance: someone reading a list of nine languages needs the screen
 * to hold still.
 */
export function Splash({ onContinue }) {
  const t = useT();
  const active = useSettingsStore(s => s.language) || 'en';

  return (
    <div className="max-w-lg w-full text-center">
      <motion.img
        src={logoUrl}
        alt={t('onboarding.graphicMeat')}
        data-testid="onboarding-logo"
        width={128}
        height={128}
        className="w-32 h-32 mx-auto mb-4"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      />

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.5 }}
      >
        <h1 className="text-2xl font-display font-bold text-mail-text">
          <span className="text-mail-accent-text">{t('onboarding.mail')}</span>{t('onboarding.vault')}
        </h1>
        <p className="text-xs text-mail-text-muted mb-5">{t('onboarding.splashTrustLine')}</p>

        <div role="radiogroup" aria-label={t('settings.language.title')}
             className="grid grid-cols-3 gap-1.5 mb-5">
          {LOCALES.map((l) => {
            const selected = l.code === active;
            return (
              <button
                key={l.code}
                role="radio"
                aria-checked={selected}
                data-testid={`onboarding-language-${l.code}`}
                onClick={() => { setLocale(l.code).catch(() => {}); }}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-left text-xs
                            transition-colors
                            ${selected
                              ? 'bg-mail-accent/10 border-mail-accent text-mail-accent-text'
                              : 'border-mail-border text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
              >
                <span className="text-base leading-none" aria-hidden="true">{l.flag}</span>
                <span className="truncate text-mail-text">{l.native}</span>
                {selected && <Check size={12} className="ml-auto flex-shrink-0" />}
              </button>
            );
          })}
        </div>

        <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">
          {t('common.continue')}
          <ArrowRight size={14} />
        </Button>
      </motion.div>
    </div>
  );
}
