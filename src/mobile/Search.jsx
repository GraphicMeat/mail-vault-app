// The search screen: a full-screen layer over the list (opened from the list header, closed by
// Back). Results come from the engine, never computed here: `mobile.search.local` answers from the
// on-device index in pages (a cursor; more rows load as the list nears its end), and
// `mobile.search.server` asks the account's server once for the newest 50 matches, for what the
// device has not synced. Typing waits SEARCH_DEBOUNCE_MS after the last key before it asks.
//
// Scope: "This folder" searches the open folder, "All accounts" every account. A server search
// needs one account and folder, so it is offered only in "This folder" (in "All accounts" it
// would ask one folder of one account and read as if it asked them all). It is offered under the
// local results, and runs by itself once a query has settled (SERVER_AUTO_DELAY_MS after the
// device answered) with nothing found on the device (or no index), so typing does not send a
// server search per pause. The results load page by page while they scroll, up to AUTO_ROWS
// rows; past that, each further page is a tap (Show more results), so the list stays bounded.
// Recent searches (last 8) are page storage on this device (store.js), shown while the field is
// empty.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { ALL_INBOXES } from './folders.js';
import MessageRow, { ROW_HEIGHT } from './MessageRow.jsx';
import { errorKey } from './errors.js';
import { useT } from './i18n.js';
import { useKeyboardViewport } from './keyboardViewport.js';

/** Quiet time after the last keystroke before the search runs. */
export const SEARCH_DEBOUNCE_MS = 250;
/** How close (px) to the end of the results the next page is asked for. */
const NEAR_END = 400;
/** How long a query must stay unchanged after the device's empty answer before the server is
 *  asked without a tap. */
export const SERVER_AUTO_DELAY_MS = 1000;
/** Rows loaded by scrolling; more only by a tap. */
export const AUTO_ROWS = 300;

const keyOf = (r) => `${r.accountId}/${r.folder}/${r.uid}`;

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />
    </svg>
  );
}

export default function Search({ onOpen, onClose, initialQuery = '' }) {
  const t = useT();
  const accountId = useMobileStore((s) => s.activeAccountId);
  // All Inboxes is no one folder: search opens on All accounts there, without "This folder".
  const folder = useMobileStore((s) => (s.activeFolder === ALL_INBOXES ? null : s.activeFolder));
  const recent = useMobileStore((s) => s.recentSearches);

  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState(folder ? 'folder' : 'all'); // 'folder' | 'all'
  // The device search: idle (no query) | loading | more (a later page loading) | done | failed
  const [local, setLocal] = useState({ state: 'idle', rows: [], cursor: null, code: null });
  // The server search: idle | loading | done | failed
  const [server, setServer] = useState({ state: 'idle', rows: [], code: null });
  const layer = useRef(null);
  const scroller = useRef(null);
  // The results end above the keyboard, not under it (keyboardViewport.js).
  useKeyboardViewport(layer, scroller);
  const gen = useRef(0); // bumps with every new query or scope: older replies are dropped
  const timer = useRef(null);
  const busyMore = useRef(false);

  const text = query.trim();

  const run = useCallback((q, sc) => {
    const mine = ++gen.current;
    busyMore.current = false;
    setServer({ state: 'idle', rows: [], code: null });
    if (!q) {
      setLocal({ state: 'idle', rows: [], cursor: null, code: null });
      return;
    }
    setLocal({ state: 'loading', rows: [], cursor: null, code: null });
    daemonCall('mobile.search.local', {
      query: q,
      ...(sc === 'folder' ? { accountId, folder } : {}),
    }).then(
      (reply) => {
        if (gen.current !== mine) return;
        setLocal({ state: 'done', rows: reply?.rows ?? [], cursor: reply?.cursor ?? null, code: null });
      },
      (err) => {
        if (gen.current !== mine) return;
        setLocal({ state: 'failed', rows: [], cursor: null, code: err?.code ?? null });
      },
    );
  }, [accountId, folder]);

  // Typing and the scope chips restart the search after a quiet moment.
  useEffect(() => {
    clearTimeout(timer.current);
    if (!text) {
      run('', scope);
      return undefined;
    }
    timer.current = setTimeout(() => run(text, scope), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [text, scope, run]);

  const loadMore = useCallback((tapped = false) => {
    if (busyMore.current || local.state !== 'done' || local.cursor == null) return;
    if (!tapped && local.rows.length >= AUTO_ROWS) return;
    busyMore.current = true;
    const mine = gen.current;
    setLocal((l) => ({ ...l, state: 'more' }));
    daemonCall('mobile.search.local', {
      query: text,
      cursor: local.cursor,
      ...(scope === 'folder' ? { accountId, folder } : {}),
    }).then(
      (reply) => {
        if (gen.current !== mine) return;
        busyMore.current = false;
        setLocal((l) => ({ state: 'done', rows: [...l.rows, ...(reply?.rows ?? [])], cursor: reply?.cursor ?? null, code: null }));
      },
      (err) => {
        if (gen.current !== mine) return;
        busyMore.current = false;
        setLocal((l) => ({ ...l, state: 'failed', code: err?.code ?? null }));
      },
    );
  }, [local.state, local.cursor, local.rows.length, text, scope, accountId, folder]);

  // A page that left room (rows the join-back dropped, a tall screen) asks for the next one.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) loadMore();
  }, [local.rows.length, local.state, loadMore]);

  const onScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) loadMore();
  }, [loadMore]);

  const searchServer = useCallback(() => {
    if (!accountId || !folder || !text) return;
    const mine = gen.current;
    setServer({ state: 'loading', rows: [], code: null });
    daemonCall('mobile.search.server', { accountId, folder, query: text }).then(
      (reply) => {
        if (gen.current === mine) setServer({ state: 'done', rows: reply?.rows ?? [], code: null });
      },
      (err) => {
        if (gen.current === mine) setServer({ state: 'failed', rows: [], code: err?.code ?? null });
      },
    );
  }, [accountId, folder, text]);

  const canServer = Boolean(accountId && folder) && scope === 'folder';
  // Nothing on the device (or no index to ask): the server is asked without a tap, once the query
  // has settled. A new keystroke or scope clears the wait (and the reply would be dropped anyway).
  const localEmpty = (local.state === 'done' && local.rows.length === 0 && local.cursor == null)
    || (local.state === 'failed' && local.code === 'SEARCH_UNAVAILABLE');
  useEffect(() => {
    if (!canServer || !localEmpty || server.state !== 'idle') return undefined;
    const wait = setTimeout(searchServer, SERVER_AUTO_DELAY_MS);
    return () => clearTimeout(wait);
  }, [canServer, localEmpty, server.state, searchServer]);

  const open = useCallback((row) => {
    useMobileStore.getState().addRecentSearch(text);
    onOpen(row);
  }, [text, onOpen]);

  const onSwipe = useCallback((kind, row) => {
    useMobileStore.getState().act(kind, { accountId: row.accountId, folder: row.folder, uids: [row.uid] });
    const same = (r) => keyOf(r) === keyOf(row);
    const change = (rows) => (kind === 'delete' ? rows.filter((r) => !same(r)) : rows.map((r) => (same(r) ? { ...r, seen: kind === 'seen' } : r)));
    setLocal((l) => ({ ...l, rows: change(l.rows) }));
    setServer((s) => ({ ...s, rows: change(s.rows) }));
  }, []);

  const onSubmit = (e) => {
    e.preventDefault();
    if (!text) return;
    useMobileStore.getState().addRecentSearch(text);
    clearTimeout(timer.current);
    run(text, scope);
    e.currentTarget.querySelector('input')?.blur();
  };

  const seen = new Set(local.rows.map(keyOf));
  const serverRows = server.rows.filter((r) => !seen.has(keyOf(r)));
  const shown = [...local.rows, ...serverRows];
  const busy = local.state === 'loading';

  const rowsView = shown.map((row, i) => (
    <div key={keyOf(row)} className="mv-search__item" style={{ height: `${ROW_HEIGHT}px` }}>
      <MessageRow row={row} index={i} onOpen={open} onSwipe={onSwipe} />
    </div>
  ));
  const firstServer = local.rows.length;

  return (
    <section ref={layer} className="mv-kb-layer mv-search" role="dialog" aria-modal="true" aria-label={t('mobile.search.title')}>
      <header className="mv-search__bar">
        <form className="mv-search__form" role="search" onSubmit={onSubmit}>
          <span className="mv-search__glass"><SearchIcon /></span>
          <input
            className="mv-search__input"
            type="search"
            enterKeyHint="search"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            dir="auto"
            value={query}
            placeholder={t('mobile.search.placeholder')}
            aria-label={t('mobile.search.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <button type="button" className="mv-compose__back" onClick={onClose}>{t('common.cancel')}</button>
      </header>
      <div className="mv-search__scopes" role="group" aria-label={t('mobile.search.scope')}>
        {folder && (
          <button type="button" className="mv-search__chip" aria-pressed={scope === 'folder'} onClick={() => setScope('folder')}>
            {t('mobile.search.thisFolder')}
          </button>
        )}
        <button type="button" className="mv-search__chip" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
          {t('mobile.search.allAccounts')}
        </button>
      </div>
      <div ref={scroller} className="mv-search__results" data-mv-search-results onScroll={onScroll}>
        {!text && (
          recent.length > 0 && (
            <div className="mv-search__recent">
              <div className="mv-search__recent-head">
                <h2 className="mv-search__heading">{t('mobile.search.recent')}</h2>
                <button type="button" className="mv-search__link" onClick={() => useMobileStore.getState().clearRecentSearches()}>
                  {t('common.clear')}
                </button>
              </div>
              <ul className="mv-search__recent-list">
                {recent.map((q) => (
                  <li key={q}>
                    <button type="button" className="mv-search__recent-item" dir="auto" onClick={() => setQuery(q)}>{q}</button>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
        {text && busy && <p className="mv-search__note" role="status">{t('mobile.search.searching')}</p>}
        {text && local.state === 'failed' && (
          <p className="mv-search__note" role="alert">{t(errorKey(local.code))}</p>
        )}
        {text && shown.length > 0 && (
          <div className="mv-search__list">
            {rowsView.slice(0, firstServer)}
            {local.state === 'more' && <p className="mv-search__note" role="status">{t('mobile.search.searching')}</p>}
            {local.state === 'done' && local.cursor != null && local.rows.length >= AUTO_ROWS && (
              <button type="button" className="mv-search__server-btn" data-mv-search-more onClick={() => loadMore(true)}>
                {t('mobile.search.more')}
              </button>
            )}
            {firstServer < rowsView.length && (
              <>
                <h2 className="mv-search__heading mv-search__heading--server">{t('mobile.search.fromServer')}</h2>
                {rowsView.slice(firstServer)}
              </>
            )}
          </div>
        )}
        {text && local.state === 'done' && shown.length === 0 && (server.state === 'done' || !canServer) && (
          <p className="mv-search__note">{t('mobile.search.none')}</p>
        )}
        {text && canServer && local.state !== 'idle' && !busy && (
          <div className="mv-search__server">
            {server.state === 'loading' ? (
              <p className="mv-search__note" role="status">{t('mobile.search.serverBusy')}</p>
            ) : (
              <>
                {server.state === 'failed' && <p className="mv-search__note" role="alert">{t(errorKey(server.code))}</p>}
                {server.state === 'done' && serverRows.length === 0 && local.rows.length > 0 && (
                  <p className="mv-search__note">{t('mobile.search.serverNone')}</p>
                )}
                {server.state !== 'done' && (
                  <button type="button" className="mv-search__server-btn" data-mv-search-server onClick={searchServer}>
                    {t('mobile.search.server')}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
