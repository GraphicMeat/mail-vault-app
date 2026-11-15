// Settings > Storage (the engine's `storage.rs`, `mobile.storage.get`): the room MailVault takes on
// the phone in all, then per account (its messages, their bodies and offline attachments), then
// the shared files: the mail database, the search index, the logs and the system cache (which the
// phone may empty by itself). What stays on the phone is chosen in Settings > Offline: the last
// row opens it (`onOpenOffline`), nothing here duplicates it.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { formatSize } from './format.js';

function Row({ label, hint, size, name }) {
  return (
    <li className="mv-setrow" data-mv-storage={name}>
      <span className="mv-setting__text">
        <span className="mv-setting__label" dir="auto">{label}</span>
        {hint && <span className="mv-setting__hint">{hint}</span>}
      </span>
      <span className="mv-setting__hint">{formatSize(size || 0)}</span>
    </li>
  );
}

export default function StorageSettings({ onOpenOffline }) {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const next = await daemonCall('mobile.storage.get', {});
      if (mounted.current) {
        setState(next);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const labelOf = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? (a.displayName || a.email) : id;
  };

  return (
    <>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('settings.storage.usageUnavailable')}</p>}
      {!state && !failed && <p className="mv-settings__note" role="status">{t('settings.storage.calculating')}</p>}
      {state && (
        <>
          <ul className="mv-settings__list">
            <Row name="total" label={t('settings.storage.localStorageUsage')} size={state.totalBytes} />
          </ul>
          {state.accounts.length > 0 && (
            <>
              <h2 className="mv-settings__heading">{t('settings.tab.accounts')}</h2>
              <ul className="mv-settings__list" data-mv-storage-accounts>
                {state.accounts.map((a) => (
                  <Row
                    key={a.accountId}
                    name={`account:${a.accountId}`}
                    label={labelOf(a.accountId)}
                    hint={t('common.messageCount', { count: a.messages })}
                    size={(a.bodiesBytes || 0) + (a.attachmentsBytes || 0)}
                  />
                ))}
              </ul>
            </>
          )}
          <h2 className="mv-settings__heading">{t('settings.storage.storageStatus')}</h2>
          <ul className="mv-settings__list">
            <Row name="database" label={t('mobile.storage.database')} size={state.databaseBytes} />
            <Row name="search" label={t('settings.searchIndex.title')} size={state.searchBytes} />
            <Row name="logs" label={t('settings.tab.logs')} size={state.logsBytes} />
            <Row name="cache" label={t('mobile.storage.cache')} hint={t('mobile.storage.cacheHint')} size={state.cacheBytes} />
          </ul>
        </>
      )}
      {onOpenOffline && (
        <div className="mv-settings__list">
          <button type="button" className="mv-setting" data-mv-storage-offline onClick={onOpenOffline}>
            <span className="mv-setting__text">
              <span className="mv-setting__label">{t('mobile.settings.offline')}</span>
              <span className="mv-setting__hint">{t('mobile.storage.offlineHint')}</span>
            </span>
          </button>
        </div>
      )}
    </>
  );
}
