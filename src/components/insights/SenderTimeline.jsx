import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { compareNames } from '../../utils/collation';
import { chartLocale, compareStable } from '../../utils/insights/chartFormat';
import '../../styles/insights-charts.css';

const DAY = 86400000;
const ROW = 48;
const stamp = date => Date.parse(`${date}T00:00:00Z`);
const formatDate = date => new Intl.DateTimeFormat(chartLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(stamp(date));
const countFor = (bucket, direction) => direction === 'both' ? bucket.received + bucket.sent : bucket[direction] || 0;
const asCalendarTime = (at, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(Date.parse(at));
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day), Number(fields.hour), Number(fields.minute), Number(fields.second));
};

// Limit work and pointer density even for multi-year custom ranges. The merged
// bounds still select exactly the complete set of represented calendar days.
function boundedBuckets(buckets, limit) {
  if (buckets.length <= limit) return buckets;
  const size = Math.ceil(buckets.length / limit);
  const result = [];
  for (let offset = 0; offset < buckets.length; offset += size) {
    const group = buckets.slice(offset, offset + size);
    result.push({ startDate: group[0].startDate, endDate: group.at(-1).endDate,
      received: group.reduce((n, b) => n + b.received, 0), sent: group.reduce((n, b) => n + b.sent, 0) });
  }
  return result;
}

export default function SenderTimeline({ lanes = [], query, onQueryChange, onSelectBucket }) {
  const t = useT();
  const viewport = useRef(null);
  const [width, setWidth] = useState(900);
  const [scrollTop, setScrollTop] = useState(0);
  const start = stamp(query.startDate);
  const end = stamp(query.endDate) + DAY;
  const duration = Math.max(DAY, end - start);
  const labelWidth = width < 600 ? 112 : 184;
  const plotWidth = Math.max(120, width - labelWidth - 24);
  const bucketLimit = Math.max(4, Math.min(160, Math.floor(plotWidth / 28)));
  useEffect(() => {
    if (!viewport.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const prepared = useMemo(() => lanes.map(lane => {
    const chronological = [...lane.buckets].sort((a, b) => compareStable(a.startDate, b.startDate));
    return { ...lane, latest: lane.lastAt || chronological.flatMap(bucket => bucket.events || []).map(event => event.at).sort().at(-1) || chronological.at(-1)?.endDate || '', count: chronological.reduce((n, b) => n + countFor(b, query.direction), 0), buckets: boundedBuckets(chronological, bucketLimit) };
  }).sort((a, b) => (query.senderSort === 'count' ? b.count - a.count : compareStable(b.latest, a.latest)) || compareNames(a.address, b.address)), [lanes, bucketLimit, query.direction, query.senderSort]);
  const scaleMaximum = Math.max(1, ...prepared.flatMap(lane => lane.buckets.flatMap(b => [b.received, b.sent])));
  const circleRadius = value => 9 * Math.sqrt(value / scaleMaximum);
  const first = Math.max(0, Math.min(Math.floor(scrollTop / ROW) - 3, prepared.length - 10));
  const visible = prepared.slice(first, first + 17);
  const position = time => Math.max(2, Math.min(98, (time - start) / duration * 100));
  const marksFor = (bucket, cluster = false) => {
    const events = (bucket.events || []).filter(event => query.direction === 'both' || event.direction === query.direction)
      .map(event => ({ ...event, time: asCalendarTime(event.at, query.timeZone) })).sort((a, b) => a.time - b.time);
    const separated = events.every((event, i) => !i || (event.time - events[i - 1].time) / duration * plotWidth >= 26);
    if (!cluster && query.timelineBucket === 'message' && events.length && events.length <= bucketLimit && separated) return events.map(event => ({ ...event, received: event.direction === 'received' ? 1 : 0, sent: event.direction === 'sent' ? 1 : 0, bucket }));
    return [{ ...bucket, time: (stamp(bucket.startDate) + stamp(bucket.endDate) + DAY) / 2, bucket }];
  };
  const select = (lane, mark) => onSelectBucket?.({ senderAddress: lane.address, startDate: mark.bucket.startDate, endDate: mark.bucket.endDate, ...(mark.key ? { messageKey: mark.key } : {}) });
  return <section className="insights-chart insights-timeline">
    <div className="insights-chart-tools">
      <label className="insights-chart-field"><span>{t('insights.chart.zoom')}</span>
        <select value={query.timelineBucket} onChange={e => onQueryChange?.({ ...query, timelineBucket: e.target.value })}>
          <option value="week">{t('insights.chart.weeks')}</option><option value="day">{t('insights.chart.days')}</option><option value="message">{t('insights.chart.messages')}</option>
        </select>
      </label>
      <label className="insights-chart-field"><span>{t('insights.chart.sortSenders')}</span>
        <select value={query.senderSort} onChange={e => onQueryChange?.({ ...query, senderSort: e.target.value })}>
          <option value="recent">{t('insights.chart.sortRecent')}</option><option value="count">{t('insights.chart.sortCount')}</option>
        </select>
      </label>
      <div className="insights-timeline-legend"><span><i className="insights-received-mark" />{t('insights.chart.received')}</span><span><i className="insights-sent-mark" />{t('insights.chart.sent')}</span></div>
    </div>
    <div className="insights-timeline-axis" style={{ paddingInlineStart: labelWidth }}><span>{formatDate(query.startDate)}</span><span>{formatDate(query.endDate)}</span></div>
    {!lanes.length && <p className="insights-chart-empty">{t('insights.chart.noActivity')}</p>}
    <div ref={viewport} className="insights-timeline-viewport" role="table" aria-label={t('insights.chart.timeline')} aria-rowcount={prepared.length} tabIndex={0}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ '--insights-label-width': `${labelWidth}px` }}>
      <div className="insights-timeline-world" style={{ height: prepared.length * ROW }}>
        {visible.map((lane, index) => {
          let marks = lane.buckets.flatMap(bucket => marksFor(bucket));
          // Two different days may have events only seconds apart. Check the
          // whole row before exposing individual hit targets near midnight.
          const ordered = [...marks].sort((a, b) => a.time - b.time);
          if (ordered.some((mark, i) => i > 0 && (mark.time - ordered[i - 1].time) / duration * plotWidth < 26)) {
            marks = lane.buckets.flatMap(bucket => marksFor(bucket, true));
          }
          return <div key={lane.address} role="row" aria-label={lane.address} aria-rowindex={first + index + 1} data-sender={lane.address}
            className="insights-timeline-row" style={{ top: (first + index) * ROW, height: ROW }}>
            <span role="cell" className="insights-timeline-sender" title={lane.address}>{lane.name || lane.address}</span>
            <div role="cell" className="insights-timeline-plot">
              <svg aria-hidden="true" width="100%" height={ROW}>
                {marks.map((mark, i) => <g key={mark.key || `${mark.startDate}-${i}`}>
                  {mark.received > 0 && query.direction !== 'sent' && <svg x={`${position(mark.time)}%`} y="0" overflow="visible"><circle data-direction="received" cx={mark.sent > 0 ? -6 : 0} cy={ROW / 2} r={circleRadius(mark.received)} className="insights-event-circle" /></svg>}
                  {mark.sent > 0 && query.direction !== 'received' && <svg x={`${position(mark.time)}%`} y={ROW / 2} overflow="visible"><rect data-direction="sent" x={-circleRadius(mark.sent) / Math.sqrt(2)} y={-circleRadius(mark.sent) / Math.sqrt(2)} width={circleRadius(mark.sent) * Math.sqrt(2)} height={circleRadius(mark.sent) * Math.sqrt(2)} transform={`translate(${mark.received > 0 ? 6 : 0},0) rotate(45)`} className="insights-event-diamond" /></svg>}
                </g>)}
              </svg>
              {marks.map((mark, i) => {
                const label = mark.key ? t('insights.chart.messageLabel', { address: lane.address,
                  date: new Intl.DateTimeFormat(chartLocale(), { dateStyle: 'long', timeStyle: 'short', timeZone: query.timeZone }).format(Date.parse(mark.at)), direction: t(`insights.chart.${mark.direction}`) })
                  : t('insights.chart.bucketLabel', { address: lane.address, start: formatDate(mark.bucket.startDate), end: formatDate(mark.bucket.endDate), received: mark.received, sent: mark.sent });
                return <button type="button" key={mark.key || `${mark.startDate}-${i}`} className="insights-timeline-hit" aria-label={label} title={label}
                  style={{ left: `${position(mark.time)}%` }} onClick={() => select(lane, mark)} />;
              })}
            </div>
          </div>;
        })}
      </div>
    </div>
  </section>;
}
