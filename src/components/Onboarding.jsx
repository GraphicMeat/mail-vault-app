import React from 'react';
import { motion } from 'framer-motion';
import { useSettingsStore } from '../stores/settingsStore';
import {
  Shield,
  Key,
  Lock,
  ArrowRight,
  Mail,
  HardDrive,
  EyeOff
} from 'lucide-react';
import { t as tr, useT  } from '../i18n/index.js';

// Each card used to state a claim in the title and repeat it in the
// description ("Secure Password Storage" / "Passwords stored securely in
// system keychain"), which is one idea said twice and no mechanism named.
// The product's voice is mechanisms, not reassurance — so each card now says
// what actually happens, and the title carries the noun the sentence is about.
const features = () => ([
  {
    icon: Key,
    title: tr('onboarding.systemKeychain'),
    description: tr('onboarding.passwordHeldOsMailvault')
  },
  {
    icon: Lock,
    title: tr('onboarding.nothingPlainFile'),
    description: tr('onboarding.noPasswordEverWrittenDisk')
  },
  {
    icon: EyeOff,
    title: tr('onboarding.noAccountNoTelemetry'),
    description: tr('onboarding.thereNoMailvaultServerSend')
  },
  {
    icon: HardDrive,
    title: tr('onboarding.vault2'),
    description: tr('onboarding.eachEmailArchiveStandardEml')
  }
]);

export function Onboarding() {
  const t = useT();
  const { setOnboardingComplete } = useSettingsStore();

  const handleComplete = () => {
    setOnboardingComplete(true);
  };

  return (
    <div className="h-screen bg-mail-bg flex items-center justify-center p-4 pt-8">
      <motion.div
        initial={{ opacity: 1, y: 0 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-lg w-full"
      >
        {/* Logo */}
        <div className="text-center mb-3">
          <h1 className="text-2xl font-display font-bold text-mail-text">
            <span className="text-mail-accent-text">{t('onboarding.mail')}</span>{t('onboarding.vault')}
          </h1>
          <p className="text-xs text-mail-text-muted">
            {t('onboarding.readMailKeepMail')}
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-4">
          {/* Security Header */}
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-mail-border">
            <div className="w-8 h-8 bg-mail-accent/10 rounded-lg flex items-center justify-center">
              <Shield size={16} className="text-mail-accent-text" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-mail-text">
                {t('onboarding.whereDataLives')}
              </h2>
              <p className="text-xs text-mail-text-muted">
                {t('onboarding.allComputerBeforeAddAccount')}
              </p>
            </div>
          </div>

          {/* Feature Cards - 2 columns, compact */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {features().map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div
                  key={index}
                  className="p-2 rounded-lg border border-mail-border bg-mail-bg flex items-center gap-2"
                >
                  <div className="w-7 h-7 rounded bg-mail-accent/10 flex items-center justify-center flex-shrink-0">
                    <Icon size={14} className="text-mail-accent-text" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-xs text-mail-text leading-tight">
                      {feature.title}
                    </h3>
                    <p className="text-[10px] text-mail-text-muted leading-tight">
                      {feature.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Keychain Permission Notice */}
          <div className="bg-mail-warning/10 border border-mail-warning/20 rounded-lg p-2 mb-3">
            <div className="flex items-center gap-2">
              <Key size={14} className="text-mail-warning flex-shrink-0" />
              <div>
                <h4 className="font-medium text-xs text-mail-warning">
                  {t('onboarding.keychainWillAskPermission')}
                </h4>
                <p className="text-[10px] text-mail-text-muted">
                  Choose &ldquo;Always Allow&rdquo; the first time, or it asks again on every sync.
                </p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end">

            <button
              onClick={handleComplete}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-mail-accent-fill
                        hover:bg-mail-accent-hover text-white font-medium rounded-lg
                        transition-colors text-xs"
            >
              {t('onboarding.getStarted')}
              <Mail size={14} />
            </button>
          </div>
        </div>

      </motion.div>
    </div>
  );
}
