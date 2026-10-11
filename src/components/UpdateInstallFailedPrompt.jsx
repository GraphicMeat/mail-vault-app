import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { relaunch } from '@tauri-apps/plugin-process';
import { ConfirmDialog } from './ConfirmDialog';
import { useSettingsStore } from '../stores/settingsStore';
import { flushSafeStorage } from '../stores/safeStorage';
import { isRecoverableInstallFailure } from '../utils/updateInstallFailure';
import { useT } from '../i18n/index.js';

/**
 * Follows Sparkle's own "An error occurred while running the updater" alert
 * when its installer died before it touched the app: on the app's first run
 * after an install from a download, macOS refused the installer its cache
 * folder (seen on 2.15.0 -> 2.19.1). The download is intact and a fresh app
 * process installs it, so the offer is a restart, after which
 * useUpdateAvailable hands the cached update straight to Sparkle.
 */
export function UpdateInstallFailedPrompt() {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (import.meta.env.VITE_MV_APPSTORE === '1') return;
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen('sparkle://did-abort-with-error', (event) => {
        if (isRecoverableInstallFailure(event.payload)) setOpen(true);
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      })
    ).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  if (!open) return null;
  return (
    <ConfirmDialog
      isOpen
      icon={(
        <div className="w-10 h-10 rounded-full flex items-center justify-center bg-mail-accent/10">
          <RefreshCw size={20} className="text-mail-accent-text" />
        </div>
      )}
      title={t('update.installFailed.title')}
      description={(
        <>
          <p>{t('update.installFailed.why')}</p>
          <p className="mt-2">{t('update.installFailed.how')}</p>
        </>
      )}
      confirmLabel={t('update.installFailed.restart')}
      cancelLabel={t('update.later')}
      onClose={() => setOpen(false)}
      onConfirm={async () => {
        useSettingsStore.setState({ updateResumeAfterRestart: true });
        setOpen(false);
        // The flag has to be on disk before this process is gone.
        await flushSafeStorage().catch(e => console.warn('[update] flush before restart failed:', e));
        relaunch().catch(e => console.warn('[update] restart failed:', e));
      }}
    />
  );
}
