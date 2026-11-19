// Settings > Storage > Storage on the phone: desktop's Storage and Search index views over the
// engine.
//
// - The download card is the phone's offline window (`offline.rs`): "Download in the background"
//   (`mobile.settings.*`'s `backgroundDownload`; the system decides when it runs), then per account
//   desktop's "Keep mail from the last" choice (1, 3, 6 months, 1 year, or All mail with Premium),
//   with how far the download is and the room it takes, and Download now. All mail without
//   Premium opens the Premium screen; All mail stored without Premium (a lapse, or an import from
//   a computer) keeps the choice while 3 months download, and says so. Read again every 4 seconds.
// - Local storage usage (`storage.rs`, `mobile.storage.get`): the total, then per account and the
//   shared files (the mail database, the search index, the logs, and the system cache the phone
//   may empty by itself).
// - Search index (`search.rs`): message bodies and attachment text (Premium, as on desktop; without
//   it the switch opens the Premium screen), the index's counts and size, and Rebuild. The engine
//   applies every change on its index worker; this page reads `mobile.search.status` every 3 seconds.
// - Deleted emails (DeletedEmails.jsx), under the page as desktop has it.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StorageView, StorageUsageRow } from '../../components/settings/views/StorageView';
import { SearchIndexView } from '../../components/settings/views/SearchIndexView';
import { SettingRow } from '../../components/ui/SettingRow';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch';
import { SegmentedChoice } from '../../components/ui/SegmentedChoice';
import { Button } from '../../components/ui/Button';
import { daemonCall } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { formatSize } from '../format.js';
import { MobileViewEnv, SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';
import DeletedEmails from './DeletedEmails.jsx';

export const WINDOWS = ['1m', '3m', '6m', '12m', 'all'];
// Desktop's keep-window choices (DownloadModeControl), literal so the catalog tests see each one.
const WINDOW_KEYS = Object.freeze({
  '1m': 'settings.storage.mo1', '3m': 'settings.storage.mo3', '6m': 'settings.storage.mo6',
  '12m': 'settings.storage.year1', all: 'settings.storage.keepAllMail',
});
const OFFLINE_MS = 4000;
const SEARCH_MS = 3000;

/** Desktop's Premium pill (DownloadModeControl). */
export function PremiumBadge() {
  const t = useT();
  return <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-mail-accent-fill text-white rounded-full">{t('common.premium')}</span>;
}

const Note = ({ error, children, ...rest }) => (
  <p className={`text-xs ${error ? 'text-mail-danger' : 'text-mail-text-muted'}`} role={error ? 'alert' : 'status'} {...rest}>{children}</p>
);

/** Reads `method` now and every `ms` (none: once): `[data, failed, reload]`. */
function usePoll(method, ms) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const load = useCallback(async () => {
    try {
      // Each method is named literally at the call sites below, for the seam scan.
      const next = await method();
      if (mounted.current) {
        setData(next);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    load();
    if (!ms) return undefined;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [load, ms]);
  return [data, failed, load, setData, setFailed];
}

function Offline({ labelOf }) {
  const t = useT();
  const [settings, settingsFailed, , setSettings] = usePoll(() => daemonCall('mobile.settings.get'));
  const [offline, offlineFailed, reload, setOffline, setOfflineFailed] = usePoll(() => daemonCall('mobile.offline.get'), OFFLINE_MS);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const premium = Boolean(offline?.premium);

  const setBackground = async (backgroundDownload) => {
    setSaving(true);
    try {
      setSettings(await daemonCall('mobile.settings.set', { backgroundDownload }));
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const pick = async (accountId, window) => {
    if (window === 'all' && !premium) {
      useMobileStore.getState().openPaywall(null);
      return;
    }
    setBusy(true);
    try {
      const entry = await daemonCall('mobile.offline.set', { accountId, window });
      setOffline((s) => (s ? { ...s, accounts: s.accounts.map((a) => (a.accountId === accountId ? entry : a)) } : s));
    } catch (err) {
      if (err?.code === 'PREMIUM_REQUIRED') useMobileStore.getState().openPaywall(null);
      else setOfflineFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const downloadNow = async () => {
    try {
      await daemonCall('mobile.offline.downloadNow', {});
      setAsked(true);
    } catch {
      setOfflineFailed(true);
    }
    reload();
  };

  return (
    <>
      {settingsFailed && <Note error>{t('mobile.settings.loadFailed')}</Note>}
      <SettingRow label={t('mobile.settings.downloadToggle')} description={t('mobile.settings.downloadHint')}>
        <ToggleSwitch label={t('mobile.settings.downloadToggle')} active={settings ? settings.backgroundDownload !== false : true}
          disabled={!settings || saving} onClick={() => setBackground(settings?.backgroundDownload === false)} />
      </SettingRow>
      {saveFailed && <Note error>{t('mobile.settings.saveFailed')}</Note>}
      {offlineFailed && <Note error>{t('mobile.offline.loadFailed')}</Note>}
      {offline?.network?.constrained && <Note data-mv-offline-lowdata>{t('mobile.offline.lowData')}</Note>}
      {offline && (
        <div className="space-y-3" data-mv-offline>
          <div className="text-sm font-medium text-mail-text">{t('settings.storage.keepWindow')}</div>
          {offline.accounts.map((entry) => {
            const label = labelOf(entry.accountId);
            // All mail stored, 3 months downloaded: worded for a phone that never had Premium too.
            const needsPremium = entry.window === 'all' && entry.effectiveWindow !== 'all';
            const bytes = (entry.bodiesBytes || 0) + (entry.attachmentsBytes || 0);
            return (
              <div key={entry.accountId} data-mv-offline-account={entry.accountId}>
                <SettingRow label={label} description={`${t('mobile.offline.progress', { offline: entry.offline, total: entry.messages })} · ${t('mobile.offline.storage', { size: formatSize(bytes) })}`}>
                  <SegmentedChoice label={t('mobile.offline.window', { account: label })} value={entry.window} onChange={(w) => pick(entry.accountId, w)}
                    options={WINDOWS.map((w) => ({ value: w, disabled: busy, label: <>{t(WINDOW_KEYS[w])}{w === 'all' && !premium && <PremiumBadge />}</> }))} />
                </SettingRow>
                {needsPremium && <Note data-mv-offline-lapsed>{t('mobile.offline.allNeedsPremium')}</Note>}
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-mail-text-muted">{asked ? t('mobile.offline.downloading') : t('mobile.offline.hint')}</p>
            <Button size="sm" className="shrink-0 whitespace-nowrap" data-mv-download-now onClick={downloadNow}>{t('mobile.offline.downloadNow')}</Button>
          </div>
        </div>
      )}
    </>
  );
}

function SearchIndex() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const premium = useMobileStore((s) => s.premium?.premium === true);
  const [status, failed, reload, , setFailed] = usePoll(() => daemonCall('mobile.search.status', {}), SEARCH_MS);
  const [save, saveFailed] = useSavePrefs();
  const paywall = () => useMobileStore.getState().openPaywall(null);
  const set = async (patch) => {
    await save(patch);
    reload();
  };
  const rebuild = async () => {
    try {
      await daemonCall('mobile.search.rebuild', {});
    } catch {
      setFailed(true);
    }
    reload();
  };
  const bodies = prefs.searchIndexBodies !== false;
  const attachments = premium && prefs.searchIndexAttachments !== false;
  return (
    <SearchIndexView description={t('mobile.searchIndex.description')}
      hints={{ bodies: t('mobile.searchIndex.bodiesHint'), attachments: <>{t('mobile.searchIndex.attachmentsHint')}{!premium && <PremiumBadge />}</> }}
      messages={{ recovering: t('mobile.searchIndex.unavailable') }}
      enabled bodies={bodies} attachments={attachments}
      onBodies={() => set({ searchIndexBodies: !bodies })}
      onAttachments={() => (premium ? set({ searchIndexAttachments: !attachments }) : paywall())}
      info={status} error={failed ? 'mobile.settings.loadFailed' : null} onRebuild={rebuild} onUpgrade={paywall}>
      <SaveFailed failed={saveFailed} />
    </SearchIndexView>
  );
}

export default function Storage() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [usage, usageFailed] = usePoll(() => daemonCall('mobile.storage.get', {}));
  const labelOf = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? (a.displayName || a.email) : id;
  };
  const messages = (usage?.accounts || []).reduce((sum, a) => sum + (a.messages || 0), 0);
  const usageText = usage
    ? `${formatSize(usage.totalBytes || 0)} ${t('settings.storage.emailsSavedParen', { count: messages })}`
    : usageFailed ? t('settings.storage.usageUnavailable') : t('settings.storage.calculating');

  return (
    <MobileViewEnv>
      <StorageView statusNote={null} downloadTitle={t('mobile.settings.offline')} download={<Offline labelOf={labelOf} />} usage={usageText}
        usageExtras={usage && (
          <>
            {usage.accounts.map((a) => (
              <StorageUsageRow key={a.accountId} data-mv-storage={`account:${a.accountId}`} label={<span dir="auto">{labelOf(a.accountId)}</span>}
                hint={t('common.messageCount', { count: a.messages })} value={formatSize((a.bodiesBytes || 0) + (a.attachmentsBytes || 0))} />
            ))}
            <StorageUsageRow data-mv-storage="database" label={t('mobile.storage.database')} value={formatSize(usage.databaseBytes || 0)} />
            <StorageUsageRow data-mv-storage="search" label={t('settings.searchIndex.title')} value={formatSize(usage.searchBytes || 0)} />
            <StorageUsageRow data-mv-storage="logs" label={t('settings.tab.logs')} value={formatSize(usage.logsBytes || 0)} />
            <StorageUsageRow data-mv-storage="cache" label={t('mobile.storage.cache')} hint={t('mobile.storage.cacheHint')} value={formatSize(usage.cacheBytes || 0)} />
          </>
        )}
        searchIndex={<SearchIndex />} />
      <DeletedEmails />
    </MobileViewEnv>
  );
}
