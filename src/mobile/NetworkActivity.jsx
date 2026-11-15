// Settings > Network Activity: desktop's page (NetworkActivity.jsx) for the phone. The engine keeps
// every connection it made (`mobile.netActivity.list`, engine `net_activity.rs`: core's store and
// its offline country lookup), for the period chosen here (`mobile.netActivity.setRetention`).
// Range, account and country are asked of the engine, which answers the rows, the countries and
// the totals; protocol and purpose narrow the rows on screen, as on desktop. Desktop's world map is
// a list of countries here (a phone is too narrow for it): tap one to see only its connections.
// Read again every few seconds while the page is open, so a connection that just closed appears.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useT, getMobileLocale } from './i18n.js';
import { formatSize } from './format.js';
import { Choice } from './SettingsPrefs.jsx';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const RANGES = { hour: HOUR, day: DAY, week: 7 * DAY, twoWeeks: 14 * DAY, month: 30 * DAY };
const RETENTIONS = ['day', 'week', 'twoWeeks', 'month'];
const PROTOCOL_LABELS = { imap: 'IMAP', smtp: 'SMTP', https: 'HTTPS', http: 'HTTP', dns: 'DNS', tcpProbe: 'TCP' };
// Core's purpose strings; one it adds later shows as it comes.
const PURPOSE_KEYS = {
  sync: 'netActivity.purposes.sync',
  'open message': 'netActivity.purposes.openMessage',
  send: 'netActivity.purposes.send',
  'sign-in': 'netActivity.purposes.signIn',
  unsubscribe: 'netActivity.purposes.unsubscribe',
  'connectivity check': 'netActivity.purposes.connectivityCheck',
  'account setup': 'netActivity.purposes.accountSetup',
  'alias lookup': 'netActivity.purposes.aliasLookup',
  billing: 'mobile.netActivity.purposeBilling',
};
const RESULT_KEYS = { ok: 'netActivity.ok', cancelled: 'netActivity.cancelled' };
const REFRESH_MS = 5000;

const rangesFor = (retention) => Object.keys(RANGES).filter((r) => RANGES[r] <= RANGES[retention]);
const distinct = (values) => [...new Set(values.filter(Boolean))].sort();

function countryName(code) {
  try {
    return new Intl.DisplayNames([getMobileLocale()], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function when(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  try {
    return new Intl.DateTimeFormat(getMobileLocale(), sameDay ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

export default function NetworkActivity() {
  const t = useT();
  const [query, setQuery] = useState({ range: 'day', account: '', country: '' });
  const [filters, setFilters] = useState({ protocol: '', purpose: '' });
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [retentionFailed, setRetentionFailed] = useState(false);
  const retention = data?.retention || 'week';
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // The latest load wins: an older answer that lands later is dropped.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const reply = await daemonCall('mobile.netActivity.list', {
        sinceMs: Date.now() - RANGES[query.range],
        ...(query.account ? { account: query.account } : {}),
        ...(query.country ? { country: query.country } : {}),
      });
      if (mounted.current && mine === seq.current) {
        setData(reply);
        setFailed(false);
      }
    } catch {
      if (mounted.current && mine === seq.current) setFailed(true);
    }
  }, [query]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const setRetention = async (value) => {
    try {
      await daemonCall('mobile.netActivity.setRetention', { retention: value });
      setRetentionFailed(false);
      // A range longer than the history kept has nothing more to show.
      if (RANGES[query.range] > RANGES[value]) setQuery((q) => ({ ...q, range: rangesFor(value).at(-1) }));
      else load();
    } catch {
      if (mounted.current) setRetentionFailed(true);
    }
  };

  const events = data?.events || [];
  const shown = useMemo(
    () => events.filter((e) => (!filters.protocol || e.protocol === filters.protocol) && (!filters.purpose || e.purpose === filters.purpose)),
    [events, filters],
  );
  const purposeLabel = (p) => (PURPOSE_KEYS[p] ? t(PURPOSE_KEYS[p]) : p);
  const summary = data?.summary || { hosts: 0, sent: 0, received: 0, accounts: [] };
  const accounts = distinct([...summary.accounts, query.account]);
  const countries = data?.countries || [];
  const placeName = (code) => (code === 'local' ? t('netActivity.map.localNetwork') : countryName(code));

  return (
    <div data-mv-net-activity>
      <p className="mv-settings__note">{t('mobile.netActivity.intro')}</p>
      <div className="mv-settings__list">
        <Choice
          name="netRetention"
          label={t('netActivity.retention')}
          value={retention}
          options={RETENTIONS.map((r) => [r, t(`netActivity.retentions.${r}`)])}
          onChange={setRetention}
        />
        <Choice
          name="netRange"
          label={t('netActivity.range')}
          value={query.range}
          options={rangesFor(retention).map((r) => [r, t(`netActivity.ranges.${r}`)])}
          onChange={(range) => setQuery((q) => ({ ...q, range }))}
        />
        <Choice
          name="netAccount"
          label={t('netActivity.account')}
          value={query.account}
          options={[['', t('netActivity.allAccounts')], ...accounts.map((a) => [a, a])]}
          onChange={(account) => setQuery((q) => ({ ...q, account }))}
        />
        <Choice
          name="netProtocol"
          label={t('netActivity.protocol')}
          value={filters.protocol}
          options={[['', t('netActivity.allProtocols')], ...distinct(events.map((e) => e.protocol)).map((p) => [p, PROTOCOL_LABELS[p] || p])]}
          onChange={(protocol) => setFilters((f) => ({ ...f, protocol }))}
        />
        <Choice
          name="netPurpose"
          label={t('netActivity.purpose')}
          value={filters.purpose}
          options={[['', t('netActivity.allPurposes')], ...distinct(events.map((e) => e.purpose)).map((p) => [p, purposeLabel(p)])]}
          onChange={(purpose) => setFilters((f) => ({ ...f, purpose }))}
        />
      </div>
      {retentionFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('netActivity.retentionFailed')}</p>}
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}

      <div className="mv-settings__list" data-mv-net-summary>
        {[['netActivity.hostsContacted', summary.hosts], ['netActivity.sent', formatSize(summary.sent)], ['netActivity.received', formatSize(summary.received)]].map(([key, value]) => (
          <div key={key} className="mv-settings__row mv-net__stat">
            <span className="mv-setting__text"><span className="mv-setting__hint">{t(key)}</span></span>
            <span className="mv-setting__label">{value}</span>
          </div>
        ))}
      </div>

      <h2 className="mv-settings__heading">{t('netActivity.map.countries')}</h2>
      {query.country && (
        <p className="mv-settings__note" data-mv-net-country-filter>
          {t('netActivity.map.filtered', { country: placeName(query.country) })}{' '}
          <button type="button" className="mv-textbtn" onClick={() => setQuery((q) => ({ ...q, country: '' }))}>{t('netActivity.map.clear')}</button>
        </p>
      )}
      {countries.length === 0 ? (
        <p className="mv-settings__note">{t('netActivity.map.empty')}</p>
      ) : (
        <div className="mv-settings__list">
          {countries.map((p) => (
            <button
              key={p.country}
              type="button"
              className="mv-setting"
              aria-pressed={query.country === p.country}
              data-mv-net-country={p.country}
              onClick={() => setQuery((q) => ({ ...q, country: q.country === p.country ? '' : p.country }))}
            >
              <span className="mv-setting__text">
                <span className="mv-setting__label">{placeName(p.country)}</span>
                <span className="mv-setting__hint" dir="auto">{p.hosts.join(', ')}</span>
              </span>
              <span className="mv-setting__hint">{t('netActivity.map.connections', { count: p.connections })}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mv-settings__note">{t('netActivity.map.attribution')}</p>

      <h2 className="mv-settings__heading">{t('settings.tab.networkActivity')}</h2>
      {shown.length === 0 ? (
        <p className="mv-settings__note">{t('netActivity.empty')}</p>
      ) : (
        <ul className="mv-settings__list">
          {shown.map((e, i) => {
            const dns = e.protocol === 'dns';
            const ok = Boolean(RESULT_KEYS[e.result]);
            return (
              <li key={`${e.atMs}-${e.host}-${i}`} className="mv-setrow mv-net__row" data-mv-net-row={e.host}>
                <span className="mv-setting__text">
                  <span className="mv-setting__label mv-net__host" dir="auto">
                    {PROTOCOL_LABELS[e.protocol] || e.protocol} {dns ? `${e.host} → ${e.ip || '?'}` : `${e.host}:${e.port}`}
                  </span>
                  <span className="mv-setting__hint" dir="auto">
                    {when(e.atMs)} · {purposeLabel(e.purpose)} · {e.account || t('netActivity.noAccount')}
                  </span>
                  <span className="mv-setting__hint">
                    {t('netActivity.sent')} {formatSize(e.bytesUp)} · {t('netActivity.received')} {formatSize(e.bytesDown)}
                  </span>
                  <span className={ok ? 'mv-setting__hint' : 'mv-setting__hint mv-net__failed'}>{ok ? t(RESULT_KEYS[e.result]) : e.result}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
