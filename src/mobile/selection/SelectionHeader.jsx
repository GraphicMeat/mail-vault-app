// The header while the list is selecting: Cancel, how many are ticked, Select all. Replaces the
// list's own header (App.jsx). Cancel and Escape leave selecting; Select all ticks every row the
// list has loaded (a long folder loads in pages: what has not loaded cannot be ticked).
import React, { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { useSelection } from './selectionStore.js';

/** The rows `list` (the page cache) has loaded, each with its place. */
export function loadedEntries(list) {
  const out = [];
  const store = useMobileStore.getState();
  for (let i = 0; i < (list?.total ?? 0); i++) {
    const row = list.rowAt(i);
    if (row) out.push({ row, place: store.placeOf(row) });
  }
  return out;
}

const loadedCount = (list) => {
  let n = 0;
  for (let i = 0; i < (list?.total ?? 0); i++) if (list.rowAt(i)) n++;
  return n;
};

/**
 * How many rows the list has loaded, read when the cache changes (a page lands, rows hide or come
 * back, it reloads), not on every render: the header re-renders with every tick of a sweep.
 */
function useLoadedCount(list) {
  const [count, setCount] = useState(() => loadedCount(list));
  useEffect(() => {
    const read = () => setCount(loadedCount(list));
    read();
    return list?.subscribe ? list.subscribe(read) : undefined;
  }, [list]);
  return count;
}

export default function SelectionHeader() {
  const t = useT();
  const list = useMobileStore((s) => s.list);
  const count = useSelection((s) => s.items.size);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') useSelection.getState().end(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const loaded = useLoadedCount(list);
  return (
    <header className="mv-header mv-header--selecting" data-mv-selecting>
      <Button variant="ghost" size="touch" onClick={() => useSelection.getState().end()}>{t('common.cancel')}</Button>
      <div className="mv-header__titles mv-header__titles--center">
        <h1 className="mv-header__title" role="status" aria-live="polite">{t('common.selectedCount', { count })}</h1>
      </div>
      <Button
        variant="ghost"
        size="touch"
        disabled={!loaded || count >= loaded}
        onClick={() => useSelection.getState().selectAll(loadedEntries(list))}
      >
        {t('mobile.select.all')}
      </Button>
    </header>
  );
}
