import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, Search, X } from 'lucide-react';
import { useNotesStore, boardColumns, serverCopies } from '../../stores/notesStore';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore, getAccountColor } from '../../stores/settingsStore';
import { openInsightsMessage } from '../../services/workflows/openInsightsMessage';
import { cancelInsightsSelection } from '../../services/workflows/selectEmail';
import { openLink } from '../../utils/editorLinks';
import { Button } from '../ui/Button';
import { EmailViewer } from '../EmailViewer';
import { DeleteConfirmModal } from '../DeleteConfirmModal';
import NoteCard from './NoteCard';
import { useT } from '../../i18n';

const typing = el => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
// Same test the mail view's own `/` makes: a dialog over the board keeps it.
const dialogOpen = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
  .some(dialog => !dialog.closest('[hidden], [inert], [aria-hidden="true"]'));

/// Notes to Self: mail the user sent to their own addresses, as a board.
/// A full page like Insights; the mail view behind it is hidden and inert.
export default function NotesBoard({ onClose, onComposeReply }) {
  const t = useT();
  const status = useNotesStore(s => s.status);
  const cards = useNotesStore(s => s.cards);
  const filter = useNotesStore(s => s.filter);
  const payload = useNotesStore(s => s.accounts);
  const detailOpen = useNotesStore(s => s.detailOpen);
  const mailAccounts = useMailStore(s => s.accounts);
  const accountColors = useSettingsStore(s => s.accountColors) || {};
  const [active, setActive] = useState({ col: 0, row: 0 });
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const page = useRef(null), filterInput = useRef(null), board = useRef(null), returnFocus = useRef(null), request = useRef(0);
  const columns = useMemo(() => boardColumns(cards, filter), [cards, filter]);
  const store = () => useNotesStore.getState();

  useEffect(() => { page.current?.focus(); return () => { ++request.current; }; }, []);
  // `/` from anywhere on the board, never out of a field someone is typing in.
  useEffect(() => {
    const onKey = event => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || dialogOpen()) return;
      event.preventDefault();
      filterInput.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // A filtered-away card cannot keep the tab stop.
  const current = columns[active.col]?.cards[active.row] ? active : { col: 0, row: 0 };

  const closeReader = () => {
    ++request.current;
    cancelInsightsSelection();
    store().setDetailOpen(false);
    requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus());
  };
  const open = async card => {
    const id = ++request.current;
    returnFocus.current = document.activeElement;
    setError(null);
    store().setDetailOpen(false);
    const first = card.copies?.[0];
    if (!first) return;
    // The vault copy first; the server's when the vault no longer holds the
    // body (a download mode evicts it) and the folder is a real one.
    const copies = [{ ...first, source: 'vault' }];
    if (serverCopies({ copies: [first] }, payload).length) copies.push({ ...first, source: 'server' });
    try {
      const opened = await openInsightsMessage({ key: card.key, copies });
      if (id === request.current && opened !== false) store().setDetailOpen(true);
    } catch (err) {
      if (id === request.current && err?.name !== 'AbortError') setError(t('notes.openFailed'));
    }
  };
  const run = promise => Promise.resolve(promise).catch(err => {
    console.warn('[notes] action failed:', err?.message || err);
    setError(t('notes.actionFailed'));
  });
  const copyLink = card => run(navigator.clipboard?.writeText(card.links[0]));
  const openFirstLink = card => run(openLink(card.links[0]));
  const star = card => run(store().toggleStar(card));
  const done = card => run(store().markDone(card));
  const remove = card => setPendingDelete({
    executor: () => store().deleteCard(card),
    copy: { title: t('notes.deleteTitle'), description: t('notes.deleteDescription'), confirmLabel: t('common.delete') },
  });

  const moveFocus = event => {
    const el = event.target;
    if (!el?.hasAttribute?.('data-note-card')) return;
    const col = Number(el.dataset.col), row = Number(el.dataset.row);
    let next = null;
    if (event.key === 'ArrowDown') next = { col, row: Math.min(row + 1, columns[col].cards.length - 1) };
    else if (event.key === 'ArrowUp') next = { col, row: Math.max(row - 1, 0) };
    else if (event.key === 'ArrowRight' && col + 1 < columns.length) next = { col: col + 1, row: Math.min(row, columns[col + 1].cards.length - 1) };
    else if (event.key === 'ArrowLeft' && col > 0) next = { col: col - 1, row: Math.min(row, columns[col - 1].cards.length - 1) };
    else if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    if (!next) return;
    setActive(next);
    board.current?.querySelector(`[data-note-card][data-col="${next.col}"][data-row="${next.row}"]`)?.focus();
  };

  const addresses = [...new Set(payload.map(account => account.address).filter(Boolean))];
  const columnName = column => (column.auto ? t(`notes.column.${column.name.toLowerCase()}`) : column.name);

  return <section ref={page} tabIndex={-1} data-testid="notes-board" data-status={status} aria-label={t('notes.title')}
    className="flex-1 min-w-0 min-h-0 flex flex-col bg-mail-bg text-mail-text outline-none"
    onKeyDown={event => {
      if (event.key !== 'Escape' || pendingDelete) return;
      event.preventDefault();
      event.stopPropagation();
      if (store().detailOpen) closeReader();
      else onClose?.();
    }}>
    <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-mail-border">
      <div className="flex items-center gap-2 min-w-0">
        <Button variant="ghost" icon size="sm" onClick={onClose} data-testid="notes-close" title={t('notes.back')} aria-label={t('notes.back')}>
          <ArrowLeft size={18} />
        </Button>
        <h1 className="text-xl font-semibold tracking-tight truncate">{t('notes.title')}</h1>
      </div>
      <div className="flex items-center gap-2">
        <label className="relative flex items-center">
          <Search size={14} className="absolute left-2.5 text-mail-text-muted pointer-events-none" aria-hidden="true" />
          <span className="sr-only">{t('notes.filter')}</span>
          <input ref={filterInput} type="search" data-testid="notes-filter" value={filter} placeholder={t('notes.filter')}
            onChange={event => store().setFilter(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && filter) { event.preventDefault(); event.stopPropagation(); store().setFilter(''); }
            }}
            className="w-56 max-w-[40vw] pl-8 pr-2 py-1.5 text-sm rounded-md border border-mail-border bg-mail-surface text-mail-text" />
        </label>
        <Button variant="secondary" size="sm" onClick={() => store().load()} loading={status === 'loading'}
          data-testid="notes-refresh" title={t('notes.refresh')}>
          <RefreshCw size={14} />{t('notes.refresh')}
        </Button>
      </div>
    </header>
    {error && <p role="alert" className="px-6 pt-3 text-sm text-mail-warning">{error}</p>}
    <div className="flex-1 min-h-0 flex">
      <div ref={board} onKeyDown={moveFocus} data-testid="notes-columns"
        className={`min-h-0 overflow-auto p-6 flex gap-4 items-start ${detailOpen ? 'w-1/2 shrink-0' : 'flex-1'}`}>
        {status === 'loading' && !cards.length && <p role="status" className="text-sm text-mail-text-muted">{t('notes.loading')}</p>}
        {status === 'error' && <p role="alert" className="text-sm text-mail-warning">{t('notes.failed')}</p>}
        {status === 'ready' && !cards.length && <div className="m-auto max-w-md text-center py-10" data-testid="notes-empty">
          <p className="text-base font-medium">{t('notes.empty')}</p>
          {addresses.length > 0 && <ul className="mt-3 text-sm text-mail-text-muted" data-testid="notes-addresses">
            {addresses.map(address => <li key={address}>{address}</li>)}
          </ul>}
        </div>}
        {cards.length > 0 && !columns.length && <p className="text-sm text-mail-text-muted" data-testid="notes-no-matches">{t('notes.noMatches')}</p>}
        {columns.map((column, col) => <section key={column.name} data-testid="notes-column" data-column={column.name}
          aria-label={columnName(column)} className="w-72 shrink-0 flex flex-col gap-2">
          <h2 className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-mail-text-muted">
            <span className="truncate">{columnName(column)}</span><span>{column.cards.length}</span>
          </h2>
          {column.cards.map((card, row) => {
            const account = mailAccounts.find(a => a.id === card.accountId);
            return <NoteCard key={card.key} card={card} account={account}
              color={account ? getAccountColor(accountColors, account) : undefined}
              col={col} row={row} active={current.col === col && current.row === row}
              canServer={serverCopies(card, payload).length > 0}
              onFocus={() => setActive({ col, row })} onOpen={open}
              onCopyLink={copyLink} onOpenLink={openFirstLink} onStar={star} onDone={done} onDelete={remove} />;
          })}
        </section>)}
      </div>
      {detailOpen && <div className="flex-1 min-w-0 min-h-0 flex flex-col border-l border-mail-border" data-testid="notes-reader">
        <div className="flex justify-end px-2 py-1 border-b border-mail-border">
          <Button variant="ghost" size="sm" onClick={closeReader} data-testid="notes-close-reader"><X size={14} />{t('common.close')}</Button>
        </div>
        <EmailViewer onComposeReply={onComposeReply} onClose={closeReader} />
      </div>}
    </div>
    <DeleteConfirmModal pending={pendingDelete} onClose={() => setPendingDelete(null)} />
  </section>;
}
