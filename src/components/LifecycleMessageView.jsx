import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useSettingsStore } from '../stores/settingsStore';
import { useLifecycleStore, lifecycleKeys } from '../stores/lifecycleStore';
import { formatDateLong, formatEmailDate } from '../utils/dateFormat';
import { Button } from './ui/Button';

/**
 * The reader's view of one lifecycle message: laid out like a mail (from,
 * subject, date, text) so it reads as a note from MailVault, and labelled as
 * what it is. It was written by the app on this computer; nothing was sent.
 */
export function LifecycleMessageView({ onOpenBilling }) {
  const t = useT();
  const row = useLifecycleStore((s) => s.rows.find((r) => r.id === s.openId));
  const periodEnd = useSettingsStore((s) => s.billingProfile?.currentPeriodEnd);
  const keys = row && lifecycleKeys(row.kind);
  if (!row || !keys) return null;

  const body = t(keys.bodyKey, { date: periodEnd ? formatDateLong(periodEnd) : '' });

  return (
    <div data-testid="lifecycle-message" className="flex-1 min-h-0 overflow-y-auto bg-mail-bg">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-mail-accent-tint text-mail-accent-text flex items-center justify-center">
            <Sparkles size={16} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-mail-text leading-snug">{t(keys.subjectKey)}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-mail-text-muted">
              <span data-testid="lifecycle-message-from" className="font-medium text-mail-text">{t('lifecycle.from')}</span>
              <span data-testid="lifecycle-message-date" className="ml-auto whitespace-nowrap">
                {formatEmailDate(new Date(row.atMs).toISOString())}
              </span>
            </div>
          </div>
          <button type="button" data-testid="lifecycle-message-close"
            aria-label={t('common.close')} title={t('common.close')}
            onClick={() => useLifecycleStore.getState().close()}
            className="flex-shrink-0 p-1 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-border">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p data-testid="lifecycle-message-body" className="text-sm text-mail-text leading-relaxed whitespace-pre-line">{body}</p>

        <div className="mt-6">
          <Button variant="primary" size="md" onClick={onOpenBilling} data-testid="lifecycle-open-billing">
            {t('lifecycle.cta')}
          </Button>
        </div>

        <p data-testid="lifecycle-message-footer" className="mt-8 pt-4 border-t border-mail-border text-xs text-mail-text-muted leading-relaxed">
          {t('lifecycle.footer')}
        </p>
      </div>
    </div>
  );
}
