import React from 'react';
import { Info } from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore } from '../stores/settingsStore';
import { isGraphAccount } from '../services/graphConfig';
import { useT } from '../i18n/index.js';

/**
 * Shown across the top of the main view for each Outlook / Hotmail account
 * still connected through Microsoft Graph: IMAP works now, gives a better
 * experience, and the account can switch in place (Settings > Accounts >
 * Connection). "Don't show again" is remembered for that account for good; an
 * account that switches to IMAP drops out of the list on its own.
 */
export function GraphImapBanner({ onSwitch }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const dismissed = useSettingsStore(s => s.graphImapNoticeDismissed);
  const dismiss = useSettingsStore(s => s.dismissGraphImapNotice);

  const pending = (accounts || []).filter(a => isGraphAccount(a) && !dismissed?.[a.id]);
  if (!pending.length) return null;

  return (
    <>
      {pending.map(account => (
        <div
          key={account.id}
          data-testid="graph-imap-banner"
          role="status"
          className="flex items-start gap-3 px-4 py-3 bg-mail-accent/10 border-b border-mail-accent/30"
        >
          <Info size={16} className="text-mail-accent flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-mail-text font-medium truncate">{t('graphImapBanner.title', { email: account.email })}</p>
            <p className="text-xs text-mail-text-muted mt-0.5">{t('graphImapBanner.body')}</p>
          </div>
          <button
            type="button"
            onClick={() => onSwitch?.(account.id)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-mail-accent-fill text-white hover:bg-mail-accent-hover transition-colors whitespace-nowrap"
          >
            {t('graphImapBanner.switch')}
          </button>
          <button
            type="button"
            onClick={() => dismiss(account.id)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover transition-colors whitespace-nowrap"
          >
            {t('graphImapBanner.dismiss')}
          </button>
        </div>
      ))}
    </>
  );
}
