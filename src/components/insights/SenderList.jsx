import React, { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { compareNames } from '../../utils/collation';
import { chartLocale, filterSenders, senderAccessibleLabel, senderLastDate } from '../../utils/insights/chartFormat';
import '../../styles/insights-charts.css';

export default function SenderList({ senders = [], selectedAddress, onSelect, searchable = true }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const visible = useMemo(() => [...filterSenders(senders, search)].sort((a, b) => {
    const last = sender => {
      const time = sender.lastAt == null ? NaN : Date.parse(sender.lastAt);
      return Number.isFinite(time) ? time : -Infinity;
    };
    const comparison = sort === 'name' ? compareNames(a.name || a.address, b.name || b.address)
      : sort === 'count' ? b.count - a.count : last(b) - last(a);
    return comparison || compareNames(a.address, b.address);
  }), [senders, search, sort]);
  return <div className="insights-chart insights-sender-list">
    <div className="insights-chart-tools">
      {searchable && <label className="insights-chart-field">
        <span>{t('insights.chart.searchSenders')}</span>
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} />
      </label>}
      <label className="insights-chart-field"><span>{t('insights.chart.sortSenders')}</span>
        <select value={sort} onChange={e => setSort(e.target.value)}>
          <option value="recent">{t('insights.chart.sortRecent')}</option>
          <option value="count">{t('insights.chart.sortCount')}</option>
          <option value="name">{t('insights.chart.sortName')}</option>
        </select>
      </label>
    </div>
    {!visible.length && <p className="insights-chart-empty">{t('insights.chart.noSenders')}</p>}
    <ul className="insights-sender-rows" aria-label={t('insights.chart.senderList')}>
      {visible.map(sender => <li key={sender.address}>
        <button type="button" aria-label={senderAccessibleLabel(sender, t)}
          aria-pressed={selectedAddress === sender.address} onClick={() => onSelect?.(sender.address)}>
          <span className="insights-sender-identity"><strong>{sender.name || sender.address}</strong>
            {sender.name && <span>{sender.address}</span>}</span>
          <span className="insights-sender-stats"><strong>{new Intl.NumberFormat(chartLocale()).format(sender.count)}</strong>
            <span>{senderLastDate(sender, t)}</span></span>
        </button>
      </li>)}
    </ul>
  </div>;
}
