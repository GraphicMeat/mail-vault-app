import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, Pause, Play, Copy, Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { SettingsPageLayout, SettingsSection } from '../ui/SettingsForm';
import { useT, getLocale } from '../../i18n/index.js';
import { formatBytes } from '../../utils/formatBytes';
import { compareNames } from '../../utils/collation';
import { formatTime, formatDateTime } from '../../utils/dateFormat';
import {
  useNetActivityStore, visibleEvents, filterEvents, summarize, copyText, target, PROTOCOL_LABELS,
} from '../../stores/netActivityStore';

// The daemon's fixed purpose strings; one it adds later shows as it comes.
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
  export: 'common.export',
};
const RESULT_KEYS = { ok: 'netActivity.ok', cancelled: 'netActivity.cancelled' };
const CELL = 'py-1 px-2 text-left align-top whitespace-nowrap';
const SELECT = 'px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text';

function formatDuration(ms) {
  const [value, unit] = ms < 1000 ? [ms, 'millisecond'] : [Math.round(ms / 100) / 10, 'second'];
  try {
    return new Intl.NumberFormat(getLocale(), { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
  } catch {
    return `${ms} ms`;
  }
}

const purposeLabel = (t, purpose) => (PURPOSE_KEYS[purpose] ? t(PURPOSE_KEYS[purpose]) : purpose);
const distinct = values => [...new Set(values.filter(Boolean))].sort(compareNames);

const Row = React.memo(function Row({ e }) {
  const t = useT();
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
      <td className={`${CELL} text-mail-text-muted`}>{e.account || ''}</td>
      <td className={`${CELL} tabular-nums text-right`}>{formatBytes(e.bytesUp)}</td>
      <td className={`${CELL} tabular-nums text-right`}>{formatBytes(e.bytesDown)}</td>
      <td className={`${CELL} tabular-nums text-right`}>{formatDuration(e.durationMs)}</td>
      <td className={`${CELL} max-w-[14rem] truncate ${RESULT_KEYS[e.result] ? '' : 'text-mail-danger'}`} title={e.result}>
        {RESULT_KEYS[e.result] ? t(RESULT_KEYS[e.result]) : e.result}
      </td>
    </tr>
  );
});

export function NetworkActivity() {
  const t = useT();
  const events = useNetActivityStore(s => s.events);
  const rows = useNetActivityStore(visibleEvents);
  const paused = useNetActivityStore(s => s.frozen !== null);
  const loadError = useNetActivityStore(s => s.loadError);
  const remoteImages = useNetActivityStore(s => s.remoteImages);
  const [filters, setFilters] = useState({ protocol: '', purpose: '', account: '' });
  const [copied, setCopied] = useState(false);

  // The stop function also ends a pause and clears the rows for the next visit.
  useEffect(() => useNetActivityStore.getState().start(), []);

  const shown = useMemo(() => filterEvents(rows, filters), [rows, filters]);
  const summary = useMemo(() => summarize(events), [events]);
  const filter = key => e => setFilters(f => ({ ...f, [key]: e.target.value }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(shown));
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
      <SettingsSection title={t('settings.tab.networkActivity')} description={t('netActivity.intro')}>
        <div className="grid grid-cols-3 gap-2 mb-2" data-testid="net-summary">
          {stat('net-summary-hosts', 'netActivity.hostsToday', summary.hosts)}
          {stat('net-summary-sent', 'netActivity.sentToday', formatBytes(summary.sent))}
          {stat('net-summary-received', 'netActivity.receivedToday', formatBytes(summary.received))}
        </div>
        <p className="text-xs text-mail-text-muted mb-3" data-testid="net-remote-images">
          {t('netActivity.remoteImages', { blocked: remoteImages.blocked, allowed: remoteImages.loaded })}
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <select aria-label={t('netActivity.protocol')} value={filters.protocol} onChange={filter('protocol')} className={SELECT}>
            <option value="">{t('netActivity.allProtocols')}</option>
            {distinct(rows.map(e => e.protocol)).map(p => <option key={p} value={p}>{PROTOCOL_LABELS[p] || p}</option>)}
          </select>
          <select aria-label={t('netActivity.purpose')} value={filters.purpose} onChange={filter('purpose')} className={SELECT}>
            <option value="">{t('netActivity.allPurposes')}</option>
            {distinct(rows.map(e => e.purpose)).map(p => <option key={p} value={p}>{purposeLabel(t, p)}</option>)}
          </select>
          <select aria-label={t('netActivity.account')} value={filters.account} onChange={filter('account')} className={SELECT}>
            <option value="">{t('netActivity.allAccounts')}</option>
            {distinct(rows.map(e => e.account)).map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => (paused ? useNetActivityStore.getState().resume() : useNetActivityStore.getState().pause())}>
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {paused ? t('common.resume') : t('netActivity.pause')}
          </Button>
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

      <SettingsSection title={t('netActivity.notShown.title')}>
        <ul className="list-disc pl-5 space-y-1 text-sm text-mail-text-muted">
          <li>{t('netActivity.notShown.webContent')}</li>
          <li>{t('netActivity.notShown.appWindow')}</li>
          <li>{t('netActivity.notShown.updates')}</li>
          <li>{t('netActivity.notShown.innerDns')}</li>
          <li>{t('netActivity.notShown.openConnections')}</li>
          <li>{t('netActivity.notShown.signIn')}</li>
        </ul>
      </SettingsSection>
    </SettingsPageLayout>
  );
}
