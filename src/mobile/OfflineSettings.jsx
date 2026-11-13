// Settings > Offline, per account (the engine's `offline.rs`): how much mail stays on the phone
// (1, 3, 6 or 12 months, or All mail with Premium), how much room it takes (bodies and
// attachments), how far the download is ("X of Y messages offline") and "Download now". All mail
// without Premium opens the Premium screen instead; All mail stored without Premium (a lapse, or
// an import from the computer on a phone that never had it) keeps the choice, and the engine
// downloads 3 months meanwhile (a neutral note says so). Read again every few seconds while
// the screen is open, so the progress moves as the download runs.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { formatSize } from './format.js';

export const WINDOWS = ['1m', '3m', '6m', '12m', 'all'];
const REFRESH_MS = 4000;

function AccountOffline({ entry, label, premium, busy, onPick }) {
  const t = useT();
  // All mail stored, 3 months downloaded: worded for a phone that never had Premium too.
  const needsPremium = entry.window === 'all' && entry.effectiveWindow !== 'all';
  const bytes = (entry.bodiesBytes || 0) + (entry.attachmentsBytes || 0);
  return (
    <li className="mv-offline" data-mv-offline-account={entry.accountId}>
      <span className="mv-setting__label" dir="auto">{label}</span>
      <div className="mv-offline__windows" role="radiogroup" aria-label={t('mobile.offline.window', { account: label })}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={entry.window === w}
            className="mv-offline__window"
            disabled={busy}
            data-mv-window={w}
            onClick={() => onPick(entry.accountId, w)}
          >
            {t(`mobile.offline.window_${w}`)}
            {w === 'all' && !premium && <span className="mv-badge mv-offline__badge">{t('common.premium')}</span>}
          </button>
        ))}
      </div>
      <span className="mv-setting__hint" data-mv-offline-progress>
        {t('mobile.offline.progress', { offline: entry.offline, total: entry.messages })}
        {' · '}
        {t('mobile.offline.storage', { size: formatSize(bytes) })}
      </span>
      {needsPremium && <span className="mv-setting__hint" data-mv-offline-lapsed>{t('mobile.offline.allNeedsPremium')}</span>}
    </li>
  );
}

export default function OfflineSettings() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const next = await daemonCall('mobile.offline.get');
      if (mounted.current) {
        setState(next);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const onPick = useCallback(async (accountId, window) => {
    if (window === 'all' && !state?.premium) {
      useMobileStore.getState().openPaywall(null);
      return;
    }
    setBusy(true);
    try {
      const entry = await daemonCall('mobile.offline.set', { accountId, window });
      if (mounted.current) {
        setState((s) => (s ? { ...s, accounts: s.accounts.map((a) => (a.accountId === accountId ? entry : a)) } : s));
      }
    } catch (err) {
      if (err?.code === 'PREMIUM_REQUIRED') useMobileStore.getState().openPaywall(null);
      else if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [state?.premium]);

  const downloadNow = useCallback(async () => {
    try {
      await daemonCall('mobile.offline.downloadNow', {});
      if (mounted.current) setAsked(true);
    } catch {
      if (mounted.current) setFailed(true);
    }
    load();
  }, [load]);

  const labelOf = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? (a.displayName || a.email) : id;
  };

  return (
    <>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.offline.loadFailed')}</p>}
      {state?.network?.constrained && <p className="mv-settings__note" role="status" data-mv-offline-lowdata>{t('mobile.offline.lowData')}</p>}
      {state && (
        <ul className="mv-settings__list" data-mv-offline>
          {state.accounts.map((entry) => (
            <AccountOffline key={entry.accountId} entry={entry} label={labelOf(entry.accountId)} premium={Boolean(state.premium)} busy={busy} onPick={onPick} />
          ))}
          <li>
            <button type="button" className="mv-setting" data-mv-download-now onClick={downloadNow}>
              <span className="mv-setting__text">
                <span className="mv-setting__label">{t('mobile.offline.downloadNow')}</span>
                <span className="mv-setting__hint">{asked ? t('mobile.offline.downloading') : t('mobile.offline.hint')}</span>
              </span>
            </button>
          </li>
        </ul>
      )}
    </>
  );
}
