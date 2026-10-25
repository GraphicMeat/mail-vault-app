import React, { useState } from 'react';
import { Bug, ExternalLink } from 'lucide-react';
import { Button } from '../ui/Button';
import { openInBrowser } from '../../services/billingApi';
import { useT } from '../../i18n/index.js';

// The thread where we say how fast we answer reports and requests.
const PROMISE_THREAD = 'https://github.com/GraphicMeat/mail-vault-app/discussions/1';

/** A subscription still inside its free trial (the one place this is asked). */
export function isTrialing(profile) {
  return !!profile?.hasSubscription && profile.status === 'trialing';
}

/**
 * "Are you having issues?" for someone mid-trial. A trial user who hits a
 * problem usually cancels instead of writing in, so the question is asked while
 * there is still time to fix it. Yes opens the way to the report menu, No
 * closes the question; neither is remembered, it is only a prompt.
 */
export function TrialFeedbackPrompt({ onReportBug }) {
  const t = useT();
  const [answer, setAnswer] = useState(null); // null | 'yes' | 'no'

  return (
    <div className="settings-section" data-testid="trial-feedback">
      <p className="text-sm font-medium text-mail-text" data-testid="trial-feedback-question">
        {t('settings.billing.trialIssuesQuestion')}
      </p>

      {answer === null && (
        <div className="flex gap-2 mt-3">
          <Button variant="subtle" size="sm" onClick={() => setAnswer('yes')} data-testid="trial-feedback-yes">
            {t('settings.billing.trialIssuesYes')}
          </Button>
          <Button variant="subtle" size="sm" onClick={() => setAnswer('no')} data-testid="trial-feedback-no">
            {t('settings.billing.trialIssuesNo')}
          </Button>
        </div>
      )}

      {answer === 'no' && (
        <p className="text-xs text-mail-text-muted mt-2" data-testid="trial-feedback-thanks">
          {t('settings.billing.trialIssuesThanks')}
        </p>
      )}

      {answer === 'yes' && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-mail-text-muted leading-relaxed" data-testid="trial-feedback-promise">
            {t('settings.billing.trialIssuesPromise')}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="sm" onClick={onReportBug} data-testid="trial-feedback-report">
              <Bug size={14} />{t('bugReport.reportBugSuggestFeature')}
            </Button>
            <button
              type="button"
              data-testid="trial-feedback-thread"
              data-url={PROMISE_THREAD}
              onClick={() => openInBrowser(PROMISE_THREAD).catch(() => {})}
              className="inline-flex items-center gap-1.5 text-xs text-mail-accent-text hover:underline"
            >
              <ExternalLink size={12} />{t('settings.billing.trialIssuesThread')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
