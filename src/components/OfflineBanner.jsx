import React from 'react';
import { WifiOff, RefreshCw, Loader } from 'lucide-react';
import { useConnectivityStore } from '../stores/connectivityStore';
import { useT } from '../i18n/index.js';

/**
 * Shown across the top of the main view while the machine has no internet.
 *
 * Deliberately a banner and not a modal: the mail is already on this computer,
 * and a local-first archive that blocks reading when the Wi-Fi drops has the
 * story exactly backwards. It states what still works, and gets out of the way
 * on its own — the daemon's watchdog reopens its gate and the next heartbeat
 * clears this, with no click required.
 */
export function OfflineBanner() {
  const t = useT();
  const online = useConnectivityStore(s => s.online);
  const checking = useConnectivityStore(s => s.checking);
  const probe = useConnectivityStore(s => s.probe);

  if (online) return null;

  return (
    <div
      data-testid="offline-banner"
      role="status"
      className="flex items-start gap-3 px-4 py-3 bg-mail-danger/10 border-b border-mail-danger/30"
    >
      <WifiOff size={16} className="text-mail-danger flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-mail-danger font-medium">{t('offlineBanner.title')}</p>
        <p className="text-xs text-mail-text-muted mt-0.5">{t('offlineBanner.body')}</p>
      </div>
      <button
        onClick={() => probe()}
        disabled={checking}
        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-mail-danger/20
                   text-mail-danger hover:bg-mail-danger/30 disabled:opacity-50 transition-colors whitespace-nowrap"
      >
        {checking ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        {checking ? t('offlineBanner.checking') : t('offlineBanner.retry')}
      </button>
    </div>
  );
}
