import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { layoutSenderMap } from '../../utils/insights/mapLayout';
import SenderList from './SenderList';
import { chartLocale, filterSenders, senderAccessibleLabel, senderLastDate } from '../../utils/insights/chartFormat';
import '../../styles/insights-charts.css';

export default function SenderMap({ senders = [], endAt, selectedAddress, onSelect }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [tooltip, setTooltip] = useState(null);
  const tooltipRef = useRef(null);
  const [width, setWidth] = useState(720);
  const viewport = useRef(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { setWidth(Math.floor(entry.contentRect.width)); setTooltip(null); });
    observer.observe(element);
    const resize = () => setTooltip(null);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, []);
  const visible = useMemo(() => filterSenders(senders, search), [senders, search]);
  const height = Math.min(460, Math.max(320, width * .58));
  const layout = useMemo(() => layoutSenderMap(visible, { width, height, endAt }), [visible, width, height, endAt]);
  const byAddress = useMemo(() => new Map(visible.map(s => [s.address, s])), [visible]);
  const selected = senders.find(s => s.address === selectedAddress);
  const end = typeof endAt === 'number' ? endAt : Date.parse(endAt);
  const endLabel = Number.isFinite(end)
    ? new Intl.DateTimeFormat(chartLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(end) : t('insights.chart.unknownDate');
  const showTooltip = (sender, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : rect.right;
    const y = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : rect.top;
    const width = 280, height = 96, gap = 14;
    setTooltip({sender, x, y, left: Math.max(8, Math.min(x + gap, window.innerWidth - width - 8)), top: Math.max(8, y - height - gap)});
  };
  useEffect(() => {
    if (!tooltip) return undefined;
    const dismiss = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTooltip(null); } };
    const scroll = () => setTooltip(null);
    window.addEventListener('keydown', dismiss, true);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('keydown', dismiss, true); window.removeEventListener('scroll', scroll, true); };
  }, [tooltip]);
  useEffect(() => { setTooltip(null); }, [search, senders]);
  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return;
    const rect = tooltipRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(tooltip.x + 14, window.innerWidth - rect.width - 8));
    const preferredTop = tooltip.y - rect.height - 14;
    const top = preferredTop >= 8 ? preferredTop : Math.min(tooltip.y + 14, window.innerHeight - rect.height - 8);
    if (left !== tooltip.left || top !== tooltip.top) setTooltip(current => current && {...current, left, top});
  }, [tooltip]);
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
            aria-label={senderAccessibleLabel(sender, t)} aria-describedby={tooltip?.sender.address === sender.address ? 'insights-sender-tooltip' : undefined}
            aria-pressed={node.address === selectedAddress} onClick={() => onSelect?.(node.address)}
            onPointerEnter={event => showTooltip(sender, event)} onPointerMove={event => showTooltip(sender, event)}
            onPointerLeave={() => setTooltip(null)} onFocus={event => showTooltip(sender, event)} onBlur={() => setTooltip(null)}
            style={{ left: node.x, top: node.y, width: diameter, height: diameter }}>
            <span className="insights-map-bubble" style={{ width: node.radius * 2, height: node.radius * 2 }}>
              {node.radius >= 15 && <span aria-hidden="true">{(sender.name || sender.address).slice(0, 2)}</span>}
            </span>
          </button>;
        })}
      </div>}
    </div>
    {tooltip && <div ref={tooltipRef} id="insights-sender-tooltip" role="tooltip" className="insights-sender-tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}>
      <strong>{tooltip.sender.name || tooltip.sender.address}</strong>
      <span>{tooltip.sender.address}</span>
      <span>{t('insights.chart.counts', { received: tooltip.sender.received, sent: tooltip.sender.sent })}</span>
      <span>{senderLastDate(tooltip.sender, t)}</span>
    </div>}
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
