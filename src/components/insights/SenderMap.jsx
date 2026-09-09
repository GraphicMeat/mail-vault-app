import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { layoutSenderMap } from '../../utils/insights/mapLayout';
import SenderList from './SenderList';
import { chartLocale, filterSenders, senderAccessibleLabel, senderLastDate } from '../../utils/insights/chartFormat';
import '../../styles/insights-charts.css';

export default function SenderMap({ senders = [], endAt, selectedAddress, onSelect }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [width, setWidth] = useState(720);
  const viewport = useRef(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const visible = useMemo(() => filterSenders(senders, search), [senders, search]);
  const height = Math.min(460, Math.max(320, width * .58));
  const layout = useMemo(() => layoutSenderMap(visible, { width, height, endAt }), [visible, width, height, endAt]);
  const byAddress = useMemo(() => new Map(visible.map(s => [s.address, s])), [visible]);
  const selected = senders.find(s => s.address === selectedAddress);
  const end = typeof endAt === 'number' ? endAt : Date.parse(endAt);
  const endLabel = Number.isFinite(end)
    ? new Intl.DateTimeFormat(chartLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(end) : t('insights.chart.unknownDate');
  return <section className="insights-chart insights-map-section">
    <label className="insights-chart-field insights-sender-search"><span>{t('insights.chart.searchSenders')}</span>
      <input type="search" value={search} onChange={e => setSearch(e.target.value)} />
    </label>
    <p className="insights-chart-caption">{t('insights.chart.mapExplanation', { date: endLabel })}</p>
    <div ref={viewport} className="insights-map-measure">
      {width >= 480 && <div className="insights-map" role="group" aria-label={t('insights.chart.senderMap')} style={{ height }}>
        <svg aria-hidden="true" width={width} height={height}>
          {[.34, .64, .94].map(fraction => <circle key={fraction} className="insights-map-ring" cx={layout.center.x} cy={layout.center.y} r={(Math.min(width, height) / 2 - 36) * fraction} />)}
          {layout.nodes.map(node => <line key={node.address} className="insights-map-link" x1={layout.center.x} y1={layout.center.y} x2={node.x} y2={node.y} />)}
        </svg>
        <span className="insights-map-you" style={{ left: layout.center.x, top: layout.center.y }}>{t('insights.chart.you')}</span>
        <span className="insights-map-recency">{t('insights.chart.nearer')} · {t('insights.chart.older')}</span>
        {layout.nodes.map(node => {
          const sender = byAddress.get(node.address);
          const diameter = Math.max(24, node.radius * 2);
          return <button type="button" key={node.address} className="insights-map-node"
            title={senderAccessibleLabel(sender, t)} aria-label={senderAccessibleLabel(sender, t)}
            aria-pressed={node.address === selectedAddress} onClick={() => onSelect?.(node.address)}
            style={{ left: node.x, top: node.y, width: diameter, height: diameter }}>
            <span className="insights-map-bubble" style={{ width: node.radius * 2, height: node.radius * 2 }}>
              {node.radius >= 15 && <span aria-hidden="true">{(sender.name || sender.address).slice(0, 2)}</span>}
            </span>
          </button>;
        })}
      </div>}
    </div>
    {layout.omittedCount > 0 && <p className="insights-chart-caption">{t('insights.chart.omitted', { count: layout.omittedCount })}</p>}
    {selected && <div className="insights-sender-detail" aria-live="polite">
      <strong>{selected.name || selected.address}</strong><span>{selected.address}</span>
      <span>{t('insights.chart.counts', { received: selected.received, sent: selected.sent })}</span>
      <span>{senderLastDate(selected, t)}</span>
      {selected.automationEvidence?.length > 0 && <span>{t('insights.chart.automation', { evidence: selected.automationEvidence.join(', ') })}</span>}
    </div>}
    <SenderList senders={visible} selectedAddress={selectedAddress} onSelect={onSelect} searchable={false} />
  </section>;
}
