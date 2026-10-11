import React, { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, Star } from 'lucide-react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { Avatar } from '../ui/Avatar';

const ROW = 56;

export function ContactsList() {
  const t = useT();
  const { items, total, query, sort, vipOnly, selectedId, stats, setQuery, setSort, setVipOnly, select, loadMore, refreshStats } = usePeopleStore();
  // The box shows what was typed at once; the store searches once typing pauses.
  const [text, setText] = useState(query);
  useEffect(() => {
    if (text === query) return undefined;
    const timer = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const parentRef = useRef(null);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW, overscan: 8 });

  const rows = v.getVirtualItems();
  const visibleIds = rows.map(r => items[r.index]?.id).filter(Boolean).join(',');
  useEffect(() => {
    if (visibleIds) refreshStats(visibleIds.split(','));
  }, [visibleIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastIndex = rows.length ? rows[rows.length - 1].index : -1;
  useEffect(() => {
    if (lastIndex >= items.length - 10 && lastIndex >= 0 && items.length < total) loadMore();
  }, [lastIndex, items.length, total, loadMore]);

  return (
    <section className="w-80 flex flex-col border-r border-mail-border min-h-0">
      <div className="p-3 flex flex-col gap-2">
        <input data-testid="contacts-search" value={text} onChange={e => setText(e.target.value)} placeholder={t('contacts.search')} aria-label={t('contacts.search')} className="w-full rounded px-2 py-1 border border-mail-border bg-mail-bg" />
        <div className="flex items-center gap-2">
          <select data-testid="contacts-sort" value={sort} onChange={e => setSort(e.target.value)} className="flex-1 rounded border border-mail-border bg-mail-bg px-1 py-1 text-sm">
            <option value="name">{t('contacts.sort.name')}</option>
            <option value="total">{t('contacts.sort.total')}</option>
            <option value="last">{t('contacts.sort.last')}</option>
          </select>
          <button type="button" data-testid="contacts-vip-filter" aria-pressed={vipOnly} onClick={() => setVipOnly(!vipOnly)} title={t('contacts.filter.vip')} aria-label={t('contacts.filter.vip')}><Star size={16} /></button>
          <button type="button" data-testid="contacts-new" onClick={() => select('new')} title={t('contacts.new')} aria-label={t('contacts.new')}><Plus size={16} /></button>
        </div>
      </div>
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="p-6 text-sm text-mail-text-secondary text-center">
            <p className="font-medium">{t('contacts.empty')}</p>
            <p className="mt-1">{t('contacts.emptyHint')}</p>
          </div>
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {rows.map(r => {
              const p = items[r.index];
              const st = stats[p.id];
              const count = st ? st.received + st.sentTo + st.cc : p.total;
              return (
                <button
                  type="button"
                  key={p.id}
                  data-testid={`contact-row-${p.id}`}
                  onClick={() => select(p.id)}
                  aria-current={selectedId === p.id}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW, transform: `translateY(${r.start}px)` }}
                  className={`flex items-center gap-3 px-3 text-left ${selectedId === p.id ? 'bg-mail-accent-tint' : ''}`}
                >
                  <Avatar name={p.displayName || p.primaryEmail} size={32} />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{p.displayName || p.primaryEmail}</span>
                    <span className="block truncate text-xs text-mail-text-secondary">{p.primaryEmail}</span>
                  </span>
                  {count != null && <span className="text-xs text-mail-text-secondary tabular-nums">{count}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
