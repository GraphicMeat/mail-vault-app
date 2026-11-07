import React from 'react';
import { ExternalLink, HelpCircle } from 'lucide-react';
import { useT } from '../i18n';
import { openExternalUrl } from '../utils/emailLinkActivation';
import outlookImapSetting from '../assets/help/outlook-imap-setting.webp';

// Outlook.com serves a mailbox over IMAP only while "Let devices and apps use
// IMAP" is on; with it off, Microsoft accepts the sign-in and the IMAP server
// answers "User is authenticated but not connected".
export const OUTLOOK_IMAP_SETTINGS_URL = 'https://outlook.live.com/mail/options/mail/forwarding';
export const OUTLOOK_IMAP_FAQ_URL = 'https://mailvaultapp.com/faq/troubleshooting.html#outlook-imap-not-connected';

function FaqLink() {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => openExternalUrl(OUTLOOK_IMAP_FAQ_URL)}
      className="inline-flex items-center gap-1 text-mail-accent hover:underline"
    >
      <HelpCircle size={12} aria-hidden="true" />
      {t('help.outlookImap.faq')}
    </button>
  );
}

/** One line under a Connect over picker set to IMAP. */
export function OutlookImapHint() {
  const t = useT();
  return (
    <p className="text-xs text-mail-text-muted" data-testid="outlook-imap-hint">
      {t('help.outlookImap.hint')} <FaqLink />
    </p>
  );
}

/** The steps, the Outlook settings page and the FAQ, after Outlook refused IMAP. */
export function OutlookImapHelp() {
  const t = useT();
  return (
    <div className="p-3 rounded-lg border border-mail-border bg-mail-bg space-y-2 text-xs text-mail-text" data-testid="outlook-imap-help">
      <div className="font-medium text-sm">{t('help.outlookImap.title')}</div>
      <p className="text-mail-text-muted">{t('help.outlookImap.steps')}</p>
      <img
        src={outlookImapSetting}
        alt={t('help.outlookImap.imageAlt')}
        width={1210}
        height={250}
        className="w-full h-auto rounded border border-mail-border"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => openExternalUrl(OUTLOOK_IMAP_SETTINGS_URL)}
          className="px-3 py-1.5 bg-mail-surface-hover hover:bg-mail-border text-mail-text rounded-lg inline-flex items-center gap-1.5"
        >
          <ExternalLink size={12} aria-hidden="true" />
          {t('help.outlookImap.open')}
        </button>
        <FaqLink />
      </div>
    </div>
  );
}
