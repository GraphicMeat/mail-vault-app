import React, { useEffect, useState } from 'react';
import { isDaemonAvailable, getDaemonStatus } from '../../services/daemonClient';
import {
  Server, CheckCircle2, XCircle, Loader,
} from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';

export function DaemonSettings() {
  const t = useT();
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState(null);

  const checkConnection = async () => {
    setChecking(true);
    try {
      const ok = await isDaemonAvailable();
      setConnected(ok);
      if (ok) {
        const s = await getDaemonStatus();
        setStatus(s);
      }
    } catch {
      setConnected(false);
    }
    setChecking(false);
  };

  useEffect(() => { checkConnection(); }, []);

  return (
    <div className="p-6 space-y-6">
      {/* Connection Status */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${connected ? 'bg-mail-success-tint' : connected === false ? 'bg-mail-danger-tint' : 'bg-mail-accent/10'}`}>
            {checking ? (
              <Loader size={20} className="text-mail-accent-text animate-spin" />
            ) : connected ? (
              <CheckCircle2 size={20} className="text-mail-success" />
            ) : connected === false ? (
              <XCircle size={20} className="text-mail-danger" />
            ) : (
              <Server size={20} className="text-mail-accent-text" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">
              {checking ? t('settings.daemon.checking') : connected ? t('settings.daemon.helperConnected') : connected === false ? t('settings.daemon.helperRunning') : t('settings.daemon.backgroundHelper')}
            </h3>
            {status && (
              <p className="text-xs text-mail-text-muted">
                {t('settings.daemon.versionAndDataDir', { version: status.version, dataDir: status.data_dir })}
              </p>
            )}
          </div>
        </div>

        {connected === false && (
          <p className="text-xs text-mail-text-muted mb-3">
            {t('settings.daemon.backgroundHelperNotCurrentlyReachable')}
          </p>
        )}

        <button
          onClick={checkConnection}
          disabled={checking}
          className="text-xs font-medium text-mail-accent-text hover:text-mail-accent/80 disabled:opacity-50 transition-colors"
        >
          {checking ? t('settings.daemon.checking') : t('settings.daemon.testConnection')}
        </button>
      </div>

      {/* About */}
      <div className="text-xs text-mail-text-muted space-y-1">
        <p>{t('settings.daemon.backgroundHelperLightweightProcessHandles')}</p>
        <p>{t('settings.daemon.startsAutomaticallyWhenOpenMailvault')}</p>
      </div>
    </div>
  );
}
