// A saved view's mail (desktop's views, opened from the folder drawer as desktop's sidebar opens
// them): a full-screen layer with the view's name, the note that a view on the phone finds only
// the mail the phone keeps offline, and the rows `mobile.views.evaluate` finds (engine
// `views.rs`), newest first across accounts, page by page while they scroll. A row opens the
// message as a search result does (App.jsx); a swipe runs through the app's swipe handling and
// changes the row here once it really ran, as in Search.jsx.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import MessageRow from './MessageRow.jsx';
import { rowHeight } from './prefs.js';
import { useT } from './i18n.js';
import { viewLabel } from '../utils/viewLabel.js';

/** Pixels from the end at which the next page loads. */
const NEAR_END = 600;

const keyOf = (r) => `${r.accountId}|${r.folder}|${r.uid}`;

export default function ViewResults({ view, onOpen, onSwipe: swipeAction, onClose }) {
  const t = useT();
  const height = useMobileStore((s) => rowHeight(s.prefs));
  // `state`: loading | more | done | failed | unavailable.
  const [list, setList] = useState({ state: 'loading', rows: [], cursor: null });
  const busy = useRef(false);
  const scroller = useRef(null);
  const gen = useRef(0);

  const fetchPage = useCallback((cursor) => {
    const mine = gen.current;
    busy.current = true;
    return daemonCall('mobile.views.evaluate', { viewId: view.id, ...(cursor != null ? { cursor } : {}) }).then(
      (reply) => {
        if (gen.current !== mine) return;
        busy.current = false;
        if (reply?.available === false) {
          setList({ state: 'unavailable', rows: [], cursor: null });
          return;
        }
        setList((l) => ({ state: 'done', rows: cursor != null ? [...l.rows, ...(reply?.rows ?? [])] : reply?.rows ?? [], cursor: reply?.cursor ?? null }));
      },
      () => {
        if (gen.current !== mine) return;
        busy.current = false;
        setList((l) => ({ ...l, state: 'failed' }));
      },
    );
  }, [view.id]);

  useEffect(() => {
    gen.current += 1;
    setList({ state: 'loading', rows: [], cursor: null });
    fetchPage(null);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (busy.current || list.state !== 'done' || list.cursor == null) return;
    setList((l) => ({ ...l, state: 'more' }));
    fetchPage(list.cursor);
  }, [list.state, list.cursor, fetchPage]);

  // A page that left room (rows the join-back dropped, a tall screen) asks for the next one.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) loadMore();
  }, [list.rows.length, list.state, loadMore]);

  const onScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) loadMore();
  }, [loadMore]);

  const onSwipe = useCallback((kind, row) => {
    const same = (r) => keyOf(r) === keyOf(row);
    const applied = (done) => setList((l) => {
      if (done === 'delete' || done === 'move') return { ...l, rows: l.rows.filter((r) => !same(r)) };
      const patch = done === 'seen' || done === 'unseen' ? { seen: done === 'seen' }
        : done === 'flag' || done === 'unflag' ? { flagged: done === 'flag' } : null;
      return patch ? { ...l, rows: l.rows.map((r) => (same(r) ? { ...r, ...patch } : r)) } : l;
    });
    if (swipeAction) {
      swipeAction(kind, row, applied);
    } else if (kind !== 'move') {
      useMobileStore.getState().act(kind, { accountId: row.accountId, folder: row.folder, uids: [row.uid] });
      applied(kind);
    }
  }, [swipeAction]);

  const name = viewLabel(view, t);
  return (
    <section className="mv-drafts mv-view" role="dialog" aria-modal="true" aria-label={name} data-mv-view={view.id}>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" onClick={onClose}>{t('common.back')}</button>
        <h1 className="mv-compose__title" dir="auto">{name}</h1>
      </header>
      <p className="mv-search__note mv-view__note" data-mv-view-note>{t('mobile.views.offlineNote')}</p>
      <div ref={scroller} className="mv-search__results" data-mv-view-results onScroll={onScroll}>
        {list.state === 'loading' && <p className="mv-search__note" role="status">{t('views.preview.running')}</p>}
        {list.state === 'unavailable' && <p className="mv-search__note" role="alert">{t('views.unavailable.unavailable')}</p>}
        {list.state === 'failed' && <p className="mv-search__note" role="alert">{t('views.unavailable.error')}</p>}
        {list.state !== 'loading' && list.state !== 'unavailable' && list.rows.length === 0 && list.state !== 'failed' && (
          <p className="mv-search__note">{t('views.preview.empty')}</p>
        )}
        {list.rows.length > 0 && (
          <div className="mv-search__list">
            {list.rows.map((row, i) => (
              <div key={keyOf(row)} className="mv-search__item" style={{ height: `${height}px` }}>
                <MessageRow row={row} index={i} onOpen={onOpen} onSwipe={onSwipe} />
              </div>
            ))}
            {list.state === 'more' && <p className="mv-search__note" role="status">{t('views.preview.running')}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
