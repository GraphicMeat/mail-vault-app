// The phone's side of the shared settings views (src/components/settings/views/viewContext.jsx):
// its translator and language (i18n.js, re-rendering on a language change) and date formatters
// over its own preferences (format.js). Every phone container renders its view inside this.
import React, { useState } from 'react';
import { SettingsViewProvider } from '../../components/settings/views/viewContext';
import { useT, getMobileLocale } from '../i18n.js';
import { useMobileStore } from '../store.js';
import { formatDateOnly, formatFullDate, formatSize, formatTime } from '../format.js';

export function MobileViewEnv({ children }) {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  return (
    <SettingsViewProvider t={t} locale={getMobileLocale()}
      formatTime={(date) => formatTime(date, prefs)} formatDateOnly={(date, opts) => formatDateOnly(date, prefs, opts)}
      formatDateTime={(date) => formatFullDate(new Date(date).getTime(), prefs)} formatBytes={formatSize}>
      {children}
    </SettingsViewProvider>
  );
}

/**
 * Writes preferences (`mobile.prefs.set`, through the store's setPrefs): `[save, failed]`,
 * `failed` while the last write was refused.
 */
export function useSavePrefs() {
  const [failed, setFailed] = useState(false);
  const save = async (patch) => {
    const ok = await useMobileStore.getState().setPrefs(patch);
    setFailed(!ok);
    return ok;
  };
  return [save, failed];
}

/** The note a refused write leaves under a page. */
export function SaveFailed({ failed }) {
  const t = useT();
  return failed ? <p className="text-xs text-mail-danger" role="alert">{t('mobile.settings.saveFailed')}</p> : null;
}

/** Opens `url` the way every link leaves the app: a plain https anchor the shell hands to the system browser. */
export function openExternal(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.click();
}
