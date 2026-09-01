import React from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { DefaultMailApp } from '../settings/DefaultMailApp';
import { useT } from '../../i18n/index.js';

/**
 * "Open mail links here" — offered once, during the tour.
 *
 * Deliberately the same row Settings shows rather than a tour-only variant:
 * one place decides what the OS actually allows, so the tour cannot promise
 * something Settings then refuses. An offer, never a gate — Continue is always
 * live, whatever the OS said.
 */
export function DefaultMailStep({ onContinue }) {
  const t = useT();

  return (
    <div className="max-w-xl w-full">
      <h2 className="text-lg font-semibold text-mail-text mb-3">
        {t('settings.behavior.defaultMail.title')}
      </h2>

      <DefaultMailApp />

      <div className="flex justify-end mt-3">
        <Button
          variant="primary"
          size="lg"
          onClick={onContinue}
          data-testid="onboarding-continue"
        >
          {t('common.continue')}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
