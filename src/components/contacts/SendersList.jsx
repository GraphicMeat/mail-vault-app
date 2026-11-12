import React, { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useT } from '../../i18n';
import { useSendersStore } from '../../stores/sendersStore';
import { usePeopleStore } from '../../stores/peopleStore';
import { ContactRow } from './ContactRow';

const ROW = 56;

/** Everyone who has emailed the user, saved or not. A saved sender opens its contact. */
export function SendersList() {
  const t = useT();
  const { items, total, query, sort, load, loadMore, setQuery, setSort } = useSendersStore();
  const selectedId = usePeopleStore((s) => s.selectedId);
  const selectedSender = usePeopleStore((s) => s.sender);
  const select = usePeopleStore((s) => s.select);
  const selectSender = usePeopleStore((s) => s.selectSender);
  const changed = usePeopleStore((s) => s.changed);
  // The box shows what was typed at once; the store searches once typing pauses.
  const [text, setText] = useState(query);
  useEffect(() => {
    if (text === query) return undefined;
    const timer = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  // Loads on mount, and again after a contact write or a finished index.
  useEffect(() => { load(); }, [load, changed]);
  const parentRef = useRef(null);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW, overscan: 8 });
  const rows = v.getVirtualItems();
  const lastIndex = rows.length ? rows[rows.length - 1].index : -1;
  useEffect(() => {
    if (lastIndex >= items.length - 10 && lastIndex >= 0 && items.length < total) loadMore();
  }, [lastIndex, items.length, total, loadMore]);

  return (
    <section className="w-80 flex flex-col border-r border-mail-border min-h-0" data-testid="senders-list">
      <div className="p-3 flex flex-col gap-2">
        <input data-testid="senders-search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('contacts.search')} aria-label={t('contacts.search')} className="w-full rounded px-2 py-1 border border-mail-border bg-mail-bg" />
        <select data-testid="senders-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('contacts.sort.name')} className="rounded border border-mail-border bg-mail-bg px-1 py-1 text-sm">
          <option value="last">{t('contacts.sort.last')}</option>
          <option value="name">{t('contacts.sort.name')}</option>
          <option value="total">{t('contacts.sort.total')}</option>
        </select>
      </div>
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-6 text-sm text-mail-text-secondary text-center">{t('contacts.senders.empty')}</p>
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {rows.map((r) => {
              const s = items[r.index];
              const selected = s.personId ? selectedId === s.personId : selectedSender?.address === s.address;
              return (
                <ContactRow
                  key={s.address}
                  testId={`sender-row-${s.address}`}
                  name={s.name}
                  address={s.address}
                  count={s.received}
                  favorite={s.favorite}
                  saved={!!s.personId}
                  selected={selected}
                  onClick={() => (s.personId ? select(s.personId) : selectSender(s))}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW, transform: `translateY(${r.start}px)` }}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
