// Settings > Data usage (desktop's DataUsageSettings / DataUsageAccountCard; the engine's
// `usage.rs`): per account, what it downloaded and uploaded today, this week, month or year (UTC
// days), today against its daily limits, and the limits: "Warn when nearing daily limit" (a notice
// once a day at 80%) and "Pause background downloads at daily limit" (the offline downloads stop
// for the day; new mail, a message opened and sending never do). An empty limit is the provider's
// default on Gmail, else unlimited, as the engine reports it (`limits`). Limits are typed in MB and
// saved on blur. Graph and JMAP accounts are not measured: their limits are kept, nothing counts.
// Read again every 30 seconds while open.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { formatSize } from './format.js';

const REFRESH_MS = 30_000;
const MB = 1024 * 1024;
const PERIODS = [
  ['today', 'settings.dataUsage.period.day'],
  ['week', 'settings.dataUsage.period.week'],
  ['month', 'settings.dataUsage.period.month'],
  ['year', 'settings.dataUsage.period.year'],
];

const mbOf = (bytes) => (bytes == null ? '' : String(Math.round(bytes / MB)));

function Toggle({ label, hint, checked, disabled, onChange, name }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={hint ? `${id}-h` : undefined}
      className="mv-setting"
      data-mv-usage-toggle={name}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="mv-setting__text">
        <span className="mv-setting__label" id={`${id}-l`}>{label}</span>
        {hint && <span className="mv-setting__hint" id={`${id}-h`}>{hint}</span>}
      </span>
      <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
    </button>
  );
}

function LimitField({ label, typed, placeholder, onCommit, name }) {
  const id = useId();
  return (
    <label className="mv-setting mv-setting--choice" htmlFor={id}>
      <span className="mv-setting__text">
        <span className="mv-setting__label">{label}</span>
      </span>
      <input
        id={id}
        className="mv-setting__select mv-usage__limit"
        data-mv-usage-limit={name}
        type="number"
        inputMode="numeric"
        min="0"
        defaultValue={mbOf(typed)}
        placeholder={placeholder}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const mb = raw === '' ? null : Number(raw);
          if (mb !== null && !(Number.isFinite(mb) && mb >= 0)) return;
          const bytes = mb === null ? null : Math.round(mb * MB);
          if (bytes !== (typed ?? null)) onCommit(bytes);
        }}
      />
    </label>
  );
}

function Bar({ label, used, limit, isDefault }) {
  const t = useT();
  const share = limit > 0 ? used / limit : 0;
  return (
    <div className="mv-usage__bar" data-mv-usage-bar={label}>
      <span className="mv-setting__hint">
        {t(label)}: {formatSize(used)} / {formatSize(limit)}{isDefault ? ` (${t('mobile.dataUsage.providerDefault')})` : ''}
      </span>
      <progress className={share >= 0.8 ? 'mv-usage__meter mv-usage__meter--warn' : 'mv-usage__meter'} max={1} value={Math.min(1, share)} />
    </div>
  );
}

function AccountUsage({ entry, label, onSet }) {
  const t = useT();
  const [period, setPeriod] = useState('today');
  const limits = entry.limits || {};
  const down = limits.down || {};
  const up = limits.up || {};
  const shown = entry[period] || { down: 0, up: 0 };
  const today = entry.today || { down: 0, up: 0 };
  const capOn = limits.capEnabled === true;
  // What an empty field stands for under the cap as it is now.
  const placeholder = (side) => {
    const bytes = capOn ? side.defaultCapOn : side.defaultCapOff;
    return bytes != null ? mbOf(bytes) : t('settings.dataUsage.account.unlimited');
  };
  return (
    <li className="mv-offline" data-mv-usage-account={entry.accountId}>
      <span className="mv-setting__label" dir="auto">{label}</span>
      <div className="mv-offline__windows" role="radiogroup" aria-label={t('settings.tab.dataUsage')}>
        {PERIODS.map(([id, key]) => (
          <button key={id} type="button" role="radio" aria-checked={period === id} className="mv-offline__window" data-mv-usage-period={id} onClick={() => setPeriod(id)}>
            {t(key)}
          </button>
        ))}
      </div>
      {entry.measured ? (
        <span className="mv-setting__hint" data-mv-usage-totals>
          {t('settings.dataUsage.account.downloaded')}: {formatSize(shown.down)}
          {' · '}
          {t('settings.dataUsage.account.uploaded')}: {formatSize(shown.up)}
        </span>
      ) : (
        <span className="mv-setting__hint" role="status" data-mv-usage-unmeasured>{t('settings.dataUsage.unavailable')}</span>
      )}
      {entry.measured && (down.limitBytes != null || up.limitBytes != null) && (
        <>
          <span className="mv-setting__hint">{t('settings.dataUsage.account.todayVsDailyLimit')}</span>
          {down.limitBytes != null && <Bar label="settings.dataUsage.account.download" used={today.down} limit={down.limitBytes} isDefault={down.isProviderDefault} />}
          {up.limitBytes != null && <Bar label="settings.dataUsage.account.upload" used={today.up} limit={up.limitBytes} isDefault={up.isProviderDefault} />}
        </>
      )}
      {entry.paused && <span className="mv-setting__hint" role="status" data-mv-usage-paused>{t('mobile.dataUsage.paused')}</span>}
      <div className="mv-settings__list mv-usage__controls">
        <Toggle
          name="warn"
          label={t('settings.dataUsage.account.warnWhenNearingDailyLimit')}
          checked={limits.warnEnabled !== false}
          onChange={(v) => onSet(entry.accountId, { warnEnabled: v })}
        />
        <Toggle
          name="cap"
          label={t('settings.dataUsage.account.pauseBackgroundDownloads')}
          hint={`${t('mobile.dataUsage.pauseHint')}${limits.gmail ? ` ${t('settings.dataUsage.account.pauseBackgroundDownloadsGmailHint')}` : ''}`}
          checked={capOn}
          onChange={(v) => onSet(entry.accountId, { capEnabled: v })}
        />
        <LimitField
          name="down"
          label={t('settings.dataUsage.account.dailyDownloadLimitMb')}
          typed={entry.typed?.dailyDownLimitBytes ?? null}
          placeholder={placeholder(down)}
          onCommit={(bytes) => onSet(entry.accountId, { dailyDownLimitBytes: bytes })}
        />
        <LimitField
          name="up"
          label={t('settings.dataUsage.account.dailyUploadLimitMb')}
          typed={entry.typed?.dailyUpLimitBytes ?? null}
          placeholder={placeholder(up)}
          onCommit={(bytes) => onSet(entry.accountId, { dailyUpLimitBytes: bytes })}
        />
      </div>
    </li>
  );
}

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

  const labelOf = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? (a.displayName || a.email) : id;
  };

  return (
    <>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('settings.dataUsage.loadFailed')}</p>}
      {saveFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
      {state && state.accounts.length === 0 && <p className="mv-settings__note">{t('settings.dataUsage.addEmailAccountFirstSee')}</p>}
      {state && state.accounts.length > 0 && (
        <ul className="mv-settings__list" data-mv-usage>
          {state.accounts.map((entry) => (
            <AccountUsage key={entry.accountId} entry={entry} label={labelOf(entry.accountId)} onSet={onSet} />
          ))}
        </ul>
      )}
    </>
  );
}
