import React, { useEffect, useId, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import * as keychainSession from '../../services/keychainSession';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { ToastShell } from '../ui/ToastShell';

/**
 * Corner invitation to finish a tour the user skipped. Back on every launch
 * until they carry on, or tick "Don't show this again" and close it.
 */
export function OnboardingResumePrompt({ ready = true }) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const complete = useSettingsStore(s => s.onboardingComplete);
  const skippedAt = useSettingsStore(s => s.onboardingSkippedAt);
  const dismissed = useSettingsStore(s => s.onboardingResumeDismissed);
  const resume = useSettingsStore(s => s.resumeOnboarding);
  const dismissForever = useSettingsStore(s => s.dismissOnboardingResume);
  const [closed, setClosed] = useState(false);
  const [never, setNever] = useState(false);
  const [keychainStatus, setKeychainStatus] = useState(keychainSession.getStatus);

  useEffect(() => keychainSession.subscribe(setKeychainStatus), []);

  // Same gate as OnboardingRefreshPrompt: credential access comes first.
  const visible = ready && complete && !!skippedAt && !dismissed && !closed
    && ['idle', 'granted', 'empty'].includes(keychainStatus);

  const close = () => {
    if (never) dismissForever();
    setClosed(true);
  };

  return (
    <AnimatePresence>
      {visible && (
        <ToastShell
          position="top-right"
          bare
          className="w-96 max-w-[calc(100vw-3rem)] bg-mail-surface border border-mail-border rounded-xl p-5"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-testid="onboarding-resume-prompt"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="text-base font-semibold text-mail-text leading-snug">
              {t('onboarding.resumeTitle')}
            </h2>
            <Button variant="ghost" icon size="xs" className="shrink-0 -mt-1 -mr-1"
              aria-label={t('common.close')} onClick={close}>
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
          <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-mail-text-muted">
            {t('onboarding.resumeDescription')}
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm text-mail-text-muted cursor-pointer">
            <input type="checkbox" className="custom-checkbox" checked={never}
              data-testid="onboarding-resume-never" onChange={event => setNever(event.target.checked)} />
            {t('onboarding.resumeNever')}
          </label>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close}>
              {t('onboarding.resumeLater')}
            </Button>
            <Button variant="primary" size="sm" data-testid="onboarding-resume" onClick={resume}>
              {t('onboarding.resumeContinue')}
            </Button>
          </div>
        </ToastShell>
      )}
    </AnimatePresence>
  );
}
