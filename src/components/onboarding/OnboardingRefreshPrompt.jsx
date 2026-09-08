import React, { useEffect, useId, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import * as keychainSession from '../../services/keychainSession';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { ToastShell } from '../ui/ToastShell';

export function OnboardingRefreshPrompt({ ready = true }) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const complete = useSettingsStore(s => s.onboardingComplete);
  const seen = useSettingsStore(s => s.appearanceOnboardingPromptSeen);
  const markSeen = useSettingsStore(s => s.markAppearanceOnboardingPromptSeen);
  const setOnboardingComplete = useSettingsStore(s => s.setOnboardingComplete);
  const [visible, setVisible] = useState(false);
  const [keychainStatus, setKeychainStatus] = useState(keychainSession.getStatus);

  useEffect(() => keychainSession.subscribe(setKeychainStatus), []);

  // Let users recover credential access before offering a tour.
  const canShow = ready && complete && ['idle', 'granted', 'empty'].includes(keychainStatus);
  useEffect(() => {
    if (!canShow || seen) return;
    setVisible(true);
    // Persist on display, so quitting without dismissing still counts as seen.
    // Local visibility keeps this invitation open until the user chooses.
    markSeen();
  }, [canShow, seen, markSeen]);

  const dismiss = () => setVisible(false);

  return (
    <AnimatePresence>
      {visible && canShow && (
        <ToastShell
          position="top-right"
          bare
          className="w-96 max-w-[calc(100vw-3rem)] bg-mail-surface border border-mail-border rounded-xl p-5"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-testid="onboarding-refresh-prompt"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              dismiss();
            }
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="text-base font-semibold text-mail-text leading-snug">
              {t('onboarding.refreshTitle')}
            </h2>
            <Button variant="ghost" icon size="xs" className="shrink-0 -mt-1 -mr-1"
              aria-label={t('common.close')} onClick={dismiss}>
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
          <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-mail-text-muted">
            {t('onboarding.refreshDescription')}
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              {t('toast.dismiss')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => {
              dismiss();
              setOnboardingComplete(false);
            }}>
              {t('onboarding.refreshRestart')}
            </Button>
          </div>
        </ToastShell>
      )}
    </AnimatePresence>
  );
}
