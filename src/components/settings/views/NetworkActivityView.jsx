// Settings > Privacy & security > Network Activity as a view: every connection the app made, the
// totals and the map over the chosen range, filters, and how long the history is kept.
//
// The app owns the data and the query: `rows` (newest first as the app keeps them), `summary`
// (`{ hosts, sent, received, accounts }`), `places` (the map's countries), `query`
// (`{ range, account, country }`, asked of the app: `onQuery(patch)`), `retention` and
// `onRetention(value)` (`retentionError` when refused), `loadError`. Protocol and purpose narrow
// the rows on screen: `filters`, `onFilter(key, value)`. Optional: `remoteImages`
// (`{ blocked, loaded }`), `paused`/`onPause`/`onResume` (desktop's live feed), `notShown` (desktop's
// list of what is not recorded), `intro` (the page's description in the app's words),
// `onOpenLink(url)` for the map's attribution.
import React, { useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, Pause, Play, Copy, Check } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPageLayout, SettingsSection } from '../../ui/SettingsForm';
import { PROTOCOL_LABELS, RETENTIONS, copyText, filterEvents, rangesFor, target } from '../../../utils/netActivity';
import { NetworkMapView, countryName } from './NetworkMapView';
import { useT, useViewEnv } from './viewContext';

// The fixed purpose strings (desktop's daemon, the phone's engine: billing); one added later shows
// as it comes.
const PURPOSE_KEYS = {
  sync: 'netActivity.purposes.sync',
  'open message': 'netActivity.purposes.openMessage',
  send: 'netActivity.purposes.send',
  'sign-in': 'netActivity.purposes.signIn',
  backup: 'netActivity.purposes.backup',
  'update check': 'netActivity.purposes.updateCheck',
  'AI model': 'netActivity.purposes.aiModel',
  unsubscribe: 'netActivity.purposes.unsubscribe',
  'release notes': 'netActivity.purposes.releaseNotes',
  'connectivity check': 'netActivity.purposes.connectivityCheck',
  'account setup': 'netActivity.purposes.accountSetup',
  'alias lookup': 'netActivity.purposes.aliasLookup',
  fonts: 'netActivity.purposes.fonts',
  'email images': 'netActivity.purposes.emailImages',
  export: 'common.export',
  billing: 'mobile.netActivity.purposeBilling',
};
const RESULT_KEYS = { ok: 'netActivity.ok', cancelled: 'netActivity.cancelled' };
const CELL = 'py-1 px-2 text-left align-top whitespace-nowrap';
const SELECT = 'px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text';

function formatDuration(ms, locale) {
  const [value, unit] = ms < 1000 ? [ms, 'millisecond'] : [Math.round(ms / 100) / 10, 'second'];
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
  } catch {
    return `${ms} ms`;
  }
}

const purposeLabel = (t, purpose) => (PURPOSE_KEYS[purpose] ? t(PURPOSE_KEYS[purpose]) : purpose);
/** Each value once, as a person reads them sorted in `locale`. */
const distinct = (values, locale) => {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  return [...new Set(values.filter(Boolean))].sort((a, b) => collator.compare(String(a ?? ''), String(b ?? '')));
};

const Row = React.memo(function Row({ e }) {
  const t = useT();
  const { locale, formatTime, formatDateTime, formatBytes, Private } = useViewEnv();
  const Arrow = e.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
  const dns = e.protocol === 'dns';
  return (
    <tr data-testid="net-row" data-host={e.host} className="border-b border-mail-border last:border-0 text-mail-text">
      {/* The helper can run for days: an earlier day's row carries its date. */}
      <td className={`${CELL} tabular-nums text-mail-text-muted`}>
        {new Date(e.atMs).toDateString() === new Date().toDateString() ? formatTime(e.atMs) : formatDateTime(e.atMs)}
      </td>
      <td className={CELL}>
        <Arrow size={12} aria-hidden="true" className={e.direction === 'in' ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
        <span className="sr-only">{e.direction === 'in' ? t('netActivity.incoming') : t('netActivity.outgoing')}</span>
      </td>
      <td className={CELL}>{PROTOCOL_LABELS[e.protocol] || e.protocol}</td>
      {/* A lookup is a name and its answer, not a connection to port 53. */}
      <td className={`${CELL} max-w-[16rem] truncate`} title={!dns && e.ip ? e.ip : undefined}>
        {dns ? target(e, '\u2192') : e.host}
      </td>
      <td className={`${CELL} tabular-nums`} data-testid="net-port">{dns ? '' : e.port}</td>
      <td className={CELL}>{purposeLabel(t, e.purpose)}</td>
      <td className={`${CELL} ${e.account ? 'text-mail-text-muted' : 'text-mail-text-muted/70 italic'}`} data-testid="net-account">
        {e.account ? <Private kind="email">{e.account}</Private> : t('netActivity.noAccount')}
      </td>
      <td className={`${CELL} tabular-nums text-right`}>{formatBytes(e.bytesUp)}</td>
      <td className={`${CELL} tabular-nums text-right`}>{formatBytes(e.bytesDown)}</td>
      <td className={`${CELL} tabular-nums text-right`}>{formatDuration(e.durationMs, locale)}</td>
      <td className={`${CELL} max-w-[14rem] truncate ${RESULT_KEYS[e.result] ? '' : 'text-mail-danger'}`} title={e.result}>
        {RESULT_KEYS[e.result] ? t(RESULT_KEYS[e.result]) : e.result}
      </td>
    </tr>
  );
});

export function NetworkActivityView({ rows, summary, places, query, onQuery, retention, onRetention, retentionError = false,
  loadError = false, filters, onFilter, remoteImages = null, paused = false, onPause = null, onResume = null,
  notShown = false, intro = null, onOpenLink = () => {} }) {
  const t = useT();
  const { locale, privateAttr, formatBytes } = useViewEnv();
  const [copied, setCopied] = useState(false);
  const shown = filterEvents(rows, filters);
  const accounts = distinct([...summary.accounts, query.account], locale);

  const copy = async () => {
    try {
      // ponytail: the copied log keeps real account addresses; a clipboard write is not painted on screen.
      await navigator.clipboard.writeText(copyText(shown, t('netActivity.noAccount')));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.warn('[network-activity] copy failed:', error);
    }
  };

  const stat = (testId, labelKey, value) => (
    <div className="rounded-lg border border-mail-border px-3 py-2">
      <div className="text-xs text-mail-text-muted">{t(labelKey)}</div>
      <div className="text-base font-semibold text-mail-text" data-testid={testId}>{value}</div>
    </div>
  );

  return (
    <SettingsPageLayout data-testid="network-activity">
      <SettingsSection title={t('settings.tab.networkActivity')} description={intro ?? t('netActivity.intro')}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="flex items-center gap-2 text-xs text-mail-text-muted">
            {t('netActivity.retention')}
            <select
              value={retention}
              onChange={e => onRetention(e.target.value)}
              className={SELECT}
            >
              {RETENTIONS.map(r => <option key={r} value={r}>{t(`netActivity.retentions.${r}`)}</option>)}
            </select>
          </label>
          {retentionError && <span role="alert" className="text-xs text-mail-danger">{t('netActivity.retentionFailed')}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <select aria-label={t('netActivity.range')} value={query.range} onChange={e => onQuery({ range: e.target.value })} className={SELECT}>
            {rangesFor(retention).map(r => <option key={r} value={r}>{t(`netActivity.ranges.${r}`)}</option>)}
          </select>
          <select aria-label={t('netActivity.account')} value={query.account} onChange={e => onQuery({ account: e.target.value })} className={SELECT}>
            <option value="">{t('netActivity.allAccounts')}</option>
            {accounts.map(a => <option key={a} value={a}>{privateAttr(a, 'email')}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2" data-testid="net-summary">
          {stat('net-summary-hosts', 'netActivity.hostsContacted', summary.hosts)}
          {stat('net-summary-sent', 'netActivity.sent', formatBytes(summary.sent))}
          {stat('net-summary-received', 'netActivity.received', formatBytes(summary.received))}
        </div>
        {remoteImages && <p className="text-xs text-mail-text-muted mb-3" data-testid="net-remote-images">
          {t('netActivity.remoteImages', { blocked: remoteImages.blocked, allowed: remoteImages.loaded })}
        </p>}

        <NetworkMapView places={places} selected={query.country} onSelect={country => onQuery({ country })} onOpenLink={onOpenLink} />

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <select aria-label={t('netActivity.protocol')} value={filters.protocol} onChange={e => onFilter('protocol', e.target.value)} className={SELECT}>
            <option value="">{t('netActivity.allProtocols')}</option>
            {distinct(rows.map(e => e.protocol), locale).map(p => <option key={p} value={p}>{PROTOCOL_LABELS[p] || p}</option>)}
          </select>
          <select aria-label={t('netActivity.purpose')} value={filters.purpose} onChange={e => onFilter('purpose', e.target.value)} className={SELECT}>
            <option value="">{t('netActivity.allPurposes')}</option>
            {distinct(rows.map(e => e.purpose), locale).map(p => <option key={p} value={p}>{purposeLabel(t, p)}</option>)}
          </select>
          {query.country && (
            <span className="inline-flex items-center gap-1 text-xs text-mail-text" data-testid="net-country-filter">
              {t('netActivity.map.filtered', {
                country: query.country === 'local' ? t('netActivity.map.localNetwork') : countryName(query.country, locale),
              })}
              <Button variant="ghost" size="sm" onClick={() => onQuery({ country: '' })}>{t('netActivity.map.clear')}</Button>
            </span>
          )}
          <div className="flex-1" />
          {onPause && <Button variant="ghost" size="sm" onClick={() => (paused ? onResume() : onPause())}>
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {paused ? t('common.resume') : t('netActivity.pause')}
          </Button>}
          <Button variant="ghost" size="sm" onClick={copy} disabled={shown.length === 0}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? t('netActivity.copied') : t('netActivity.copy')}
          </Button>
        </div>

        {loadError && <p role="alert" className="text-sm text-mail-danger mb-2">{t('netActivity.loadFailed')}</p>}
        {shown.length === 0 ? (
          <p className="text-sm text-mail-text-muted py-4">{t('netActivity.empty')}</p>
        ) : (
          <div className="overflow-x-auto max-h-[28rem] overflow-y-auto rounded-lg border border-mail-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-mail-surface"><tr className="border-b border-mail-border text-mail-text-muted">
                <th className={`${CELL} font-medium`}>{t('netActivity.time')}</th>
                <th className={CELL}><span className="sr-only">{t('netActivity.direction')}</span></th>
                <th className={`${CELL} font-medium`}>{t('netActivity.protocol')}</th>
                <th className={`${CELL} font-medium`}>{t('netActivity.host')}</th>
                <th className={`${CELL} font-medium`}>{t('netActivity.port')}</th>
                <th className={`${CELL} font-medium`}>{t('netActivity.purpose')}</th>
                <th className={`${CELL} font-medium`}>{t('netActivity.account')}</th>
                <th className={`${CELL} font-medium text-right`}>{t('netActivity.sent')}</th>
                <th className={`${CELL} font-medium text-right`}>{t('netActivity.received')}</th>
                <th className={`${CELL} font-medium text-right`}>{t('netActivity.duration')}</th>
                <th className={`${CELL} font-medium`}>{t('netActivity.resultColumn')}</th>
              </tr></thead>
              <tbody>{shown.map(e => <Row key={e.id} e={e} />)}</tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      {notShown && <SettingsSection title={t('netActivity.notShown.title')}>
        <ul className="list-disc pl-5 space-y-1 text-sm text-mail-text-muted">
          <li>{t('netActivity.notShown.webContent')}</li>
          <li>{t('netActivity.notShown.appWindow')}</li>
          <li>{t('netActivity.notShown.updates')}</li>
          <li>{t('netActivity.notShown.innerDns')}</li>
          <li>{t('netActivity.notShown.openConnections')}</li>
          <li>{t('netActivity.notShown.signIn')}</li>
        </ul>
      </SettingsSection>}
    </SettingsPageLayout>
  );
}
