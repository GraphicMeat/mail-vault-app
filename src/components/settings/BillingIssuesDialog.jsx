import React, { useState } from 'react';
import { Bug, ExternalLink } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { openInBrowser } from '../../services/billingApi';
import { useT } from '../../i18n/index.js';

// The thread where we say how fast we answer reports and requests.
const PROMISE_THREAD = 'https://github.com/GraphicMeat/mail-vault-app/discussions/1';

/**
 * "Are you having issues?" raised when someone presses Manage Subscription.
 * Someone who hits a problem usually cancels instead of writing in, and the
 * portal is where a trial or subscription gets cancelled, so the question is
 * asked on the way there while there is still time to fix it. No carries on to
 * the portal; Yes opens the way to the report menu, with the portal still one
 * click away. Closing it leaves them where they were. Mount it only while it
 * is wanted: the answer is not remembered.
 */
export function BillingIssuesDialog({ onClose, onContinue, onReportBug }) {
  const t = useT();
  const [hasIssues, setHasIssues] = useState(false);

  return (
    <Dialog open onClose={onClose} portal size="sm" data-testid="billing-issues"
      title={t('settings.billing.trialIssuesQuestion')}>
      {!hasIssues && (
        <p className="text-sm text-mail-text-muted leading-relaxed mb-4" data-testid="billing-issues-intro">
          {t('settings.billing.trialIssuesIntro')}
        </p>
      )}
      {!hasIssues && (
        <div className="flex gap-2">
          <Button variant="subtle" size="md" className="flex-1" onClick={() => setHasIssues(true)} data-testid="billing-issues-yes">
            {t('settings.billing.trialIssuesYes')}
          </Button>
          <Button variant="subtle" size="md" className="flex-1" onClick={onContinue} data-testid="billing-issues-no">
            {t('settings.billing.trialIssuesNo')}
          </Button>
        </div>
      )}

      {hasIssues && (
        <div className="space-y-4">
          <p className="text-sm text-mail-text-muted leading-relaxed" data-testid="billing-issues-promise">
            {t('settings.billing.trialIssuesPromise')}
          </p>
          <p className="text-sm text-mail-text-muted leading-relaxed" data-testid="billing-issues-resolve">
            {t('settings.billing.trialIssuesResolve')}
          </p>
          <p className="text-sm text-mail-text-muted leading-relaxed" data-testid="billing-issues-legacy">
            {t('settings.billing.trialIssuesLegacy')}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="md" data-testid="billing-issues-report"
              onClick={() => { onClose(); onReportBug?.(); }}>
              <Bug size={14} />{t('bugReport.reportBugSuggestFeature')}
            </Button>
            <button
              type="button"
              data-testid="billing-issues-thread"
              data-url={PROMISE_THREAD}
              onClick={() => openInBrowser(PROMISE_THREAD).catch(() => {})}
              className="inline-flex items-center gap-1.5 text-xs text-mail-accent-text hover:underline"
            >
              <ExternalLink size={12} />{t('settings.billing.trialIssuesThread')}
            </button>
          </div>
          <button
            type="button"
            data-testid="billing-issues-continue"
            onClick={onContinue}
            className="text-xs text-mail-text-muted hover:text-mail-text hover:underline"
          >
            {t('settings.billing.trialIssuesContinue')}
          </button>
        </div>
      )}
    </Dialog>
  );
}
