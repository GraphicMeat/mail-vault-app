// Settings > Storage > Data usage on the phone: desktop's Data usage views over the engine's
// `usage.rs` (`mobile.dataUsage.*`). Per account what it downloaded and uploaded today, this week,
// month or year (UTC days), today against its daily limits, and the limits: "Warn when nearing
// daily limit" (a notice once a day at 80%) and "Pause background downloads at daily limit" (the
// offline downloads stop for the day; new mail, a message opened and sending never do). An empty
// limit is the provider's default on Gmail, else unlimited, as the engine reports it (`limits`).
// Limits are typed in MB and saved on blur. Graph and JMAP accounts are not measured: their
// limits are kept, nothing counts. Read again every 30 seconds while open.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DataUsageView, DataUsageAccountCardView } from '../../components/settings/views/DataUsageView';
import { daemonCall } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { accountColor } from '../accountColor.js';
import { MobileViewEnv } from './MobileViewEnv.jsx';

const REFRESH_MS = 30_000;
const MB = 1024 * 1024;

// MB as the field shows it: up to two decimals, so a limit under a whole MB reads as typed.
const mbOf = (bytes) => (bytes == null ? '' : String(Number((bytes / MB).toFixed(2))));

/** The field's blur: writes the limit when it changed from what the field showed. */
const commitLimit = (typed, onCommit) => (e) => {
  const raw = e.target.value.trim();
  // Unchanged from what the field showed: nothing to write (a shown value is rounded).
  const shown = mbOf(typed);
  if (raw === '' ? shown === '' : shown !== '' && Number(raw) === Number(shown)) return;
  const mb = raw === '' ? null : Number(raw);
  if (mb !== null && !(Number.isFinite(mb) && mb >= 0)) return;
  const bytes = mb === null ? null : Math.round(mb * MB);
  if (bytes !== (typed ?? null)) onCommit(bytes);
};

export default function DataUsage() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const next = await daemonCall('mobile.dataUsage.get', {});
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

  const onSet = useCallback(async (accountId, patch) => {
    try {
      const entry = await daemonCall('mobile.dataUsage.set', { accountId, ...patch });
      if (mounted.current) {
        setSaveFailed(false);
        setState((s) => (s ? { ...s, accounts: s.accounts.map((a) => (a.accountId === accountId ? entry : a)) } : s));
      }
    } catch {
      if (mounted.current) setSaveFailed(true);
    }
  }, []);

  const accountOf = (id) => accounts.find((x) => x.id === id);
  const entries = state?.accounts || [];

  return (
    <MobileViewEnv>
      <DataUsageView error={failed ? {} : null} onRetry={load} empty={Boolean(state) && entries.length === 0}>
        {saveFailed && <p className="text-xs text-mail-danger" role="alert">{t('mobile.settings.saveFailed')}</p>}
        {entries.map((entry) => {
          const account = accountOf(entry.accountId);
          const limits = entry.limits || {};
          const down = limits.down || {};
          const up = limits.up || {};
          const capOn = limits.capEnabled === true;
          // What an empty field stands for under the cap as it is now.
          const placeholder = (side) => {
            const bytes = capOn ? side.defaultCapOn : side.defaultCapOff;
            return bytes != null ? mbOf(bytes) : t('settings.dataUsage.account.unlimited');
          };
          const field = (typed, key, side) => ({
            defaultValue: mbOf(typed), placeholder: placeholder(side), inputProps: { inputMode: 'decimal', step: 'any' },
            onBlur: commitLimit(typed, (bytes) => onSet(entry.accountId, { [key]: bytes })),
          });
          return (
            <div key={entry.accountId} data-mv-usage-account={entry.accountId}>
              <DataUsageAccountCardView
                account={{ name: account?.displayName || '', email: account?.email || entry.accountId }}
                avatarColor={account ? accountColor(account) : undefined}
                avatarInitial={(account?.displayName || account?.email || '?').charAt(0).toUpperCase()}
                stats={entry} unavailable={!entry.measured}
                downLimit={down} upLimit={up} defaultSuffix={` (${t('mobile.dataUsage.providerDefault')})`}
                warnEnabled={limits.warnEnabled !== false} capEnabled={capOn}
                onWarn={(v) => onSet(entry.accountId, { warnEnabled: v })}
                onCap={(v) => onSet(entry.accountId, { capEnabled: v })}
                pauseHint={`${t('mobile.dataUsage.pauseHint')}${limits.gmail ? ` ${t('settings.dataUsage.account.pauseBackgroundDownloadsGmailHint')}` : ''}`}
                notice={entry.paused ? <p className="text-xs text-mail-warning pt-3" role="status" data-mv-usage-paused>{t('mobile.dataUsage.paused')}</p> : null}
                limits={{
                  down: field(entry.typed?.dailyDownLimitBytes ?? null, 'dailyDownLimitBytes', down),
                  up: field(entry.typed?.dailyUpLimitBytes ?? null, 'dailyUpLimitBytes', up),
                }} />
            </div>
          );
        })}
      </DataUsageView>
    </MobileViewEnv>
  );
}
