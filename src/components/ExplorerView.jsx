import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowLeft, ChevronRight, Folder, MessagesSquare, Search, X } from 'lucide-react';
import { buildExplorerTree, resolveExplorerPath } from '../utils/explorer';
import { useSettingsStore } from '../stores/settingsStore';
import { getLocale, useT } from '../i18n';
import { formatEmailDate } from '../utils/dateFormat';
import { displayText } from '../utils/bidiText';
import { backfillTrackerVerdicts } from '../services/trackerVerdicts';
import '../styles/explorer.css';

const EMPTY_PATH = Object.freeze([]);
const EMPTY_CONTEXT = Object.freeze({});
const isUnread = email => !email.flags?.includes('\\Seen');

function GroupCheckbox({ emails, selectedEmailIds, getSelectionKey, onSetSelection, label }) {
  const ref = useRef(null);
  const checked = emails.length > 0 && emails.every(email => selectedEmailIds.has(getSelectionKey(email)));
  const mixed = !checked && emails.some(email => selectedEmailIds.has(getSelectionKey(email)));
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" className="custom-checkbox" aria-label={label}
    checked={checked} disabled={!emails.length} onChange={event => onSetSelection(emails, event.target.checked)} />;
}

export function ExplorerView({
  emails, conversationEmails = emails, context = EMPTY_CONTEXT, rootLabel,
  unreadOnly = false, selectedEmailIds, getSelectionKey, onSetSelection,
  renderEmail, onSelectEmail, onOpenThread, onSearchMailbox, hasOpenThread = false, onThreadsChanged,
  partial = false, hasMore = false, loadingMore = false, loading = false, onLoadMore,
  rowHeight = 56, searchActive = false,
}) {
  const t = useT();
  const grouping = useSettingsStore(s => s.explorerGrouping);
  const dateDepth = useSettingsStore(s => s.explorerDateDepth);
  const setGrouping = useSettingsStore(s => s.setExplorerGrouping);
  const setDateDepth = useSettingsStore(s => s.setExplorerDateDepth);
  const setPath = useSettingsStore(s => s.setExplorerPath);
  const scope = JSON.stringify([context.activeAccountId, context.activeMailbox, context.viewMode,
    context.unifiedInbox, context.mailboxScope?.paths, grouping, dateDepth, searchActive]);
  const rememberedPath = useSettingsStore(s => s.explorerPaths[scope] || EMPTY_PATH);
  const locale = getLocale();
  const tree = useMemo(() => buildExplorerTree(emails, { grouping, dateDepth, locale, context, conversationEmails, includeThreads: hasOpenThread }),
    [emails, grouping, dateDepth, locale, context, conversationEmails, hasOpenThread]);
  useEffect(() => { if (tree.threads.size) onThreadsChanged?.(tree.threads); }, [tree, onThreadsChanged]);
  const { node, breadcrumbs, path } = resolveExplorerPath(tree, rememberedPath);
  const location = JSON.stringify([scope, path]);
  const [search, setSearch] = useState({ location: '', value: '' });
  const query = search.location === location ? search.value : '';
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEmails = useMemo(() => node.emails.filter(email => (!unreadOnly || isUnread(email))
    && (!normalizedQuery || [email.subject, email.from?.name, email.from?.address, email.snippet]
      .some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(normalizedQuery)))),
  [node, unreadOnly, normalizedQuery]);
  const showGroups = !normalizedQuery && node.children.length > 0;
  const entries = useMemo(() => showGroups
    ? node.children.map(group => ({ group, emails: unreadOnly ? group.emails.filter(isUnread) : group.emails }))
      .filter(entry => entry.emails.length)
    : visibleEmails.map(email => ({ email })), [showGroups, node, unreadOnly, visibleEmails]);
  const scrollRef = useRef(null);
  const rootRef = useRef(null);
  const focusAnchor = useRef(null);
  const focusAfterNavigation = useRef(false);
  const itemHeight = showGroups ? 64 : rowHeight;
  const virtualized = entries.length > 60;
  const getItemKey = useCallback(index => entries[index]?.group?.id || getSelectionKey(entries[index].email), [entries, getSelectionKey]);
  const virtualizer = useVirtualizer({ count: entries.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => itemHeight, getItemKey, overscan: 5, enabled: virtualized });
  const items = virtualized ? virtualizer.getVirtualItems()
    : entries.map((_, index) => ({ index, key: getItemKey(index) }));

  const navigate = next => { focusAfterNavigation.current = true; setPath(scope, next); };
  useEffect(() => {
    focusAnchor.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (focusAfterNavigation.current) {
      rootRef.current?.querySelector('[data-testid="explorer-back"]')?.focus();
      focusAfterNavigation.current = false;
    }
  }, [location]);
  useEffect(() => { virtualizer.measure(); }, [virtualizer, itemHeight]);

  // A message body may arrive after keyboard navigation has already scrolled.
  // Opening its reader then shrinks a stacked pane; reveal the still-focused
  // row again using the new bounds, without moving focus from another control.
  useEffect(() => {
    const root = rootRef.current;
    let frame;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (root.contains(focused) && focused.closest('[data-explorer-index]')) {
          focused.scrollIntoView?.({ block: 'nearest' });
        }
      });
    });
    observer.observe(root);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  // App-level j/k is routed here while Explorer owns the list, so it cannot
  // open a message hidden in a different group. Native arrows work locally.
  const step = useCallback(delta => {
    if (!entries.length) return;
    const anchor = focusAnchor.current;
    const current = anchor ? entries.findIndex((_, index) => getItemKey(index) === anchor.key) : -1;
    // A read message can disappear immediately in Unread. Its successor then
    // occupies its previous index, so advancing must not skip that successor.
    const next = current >= 0 ? current + delta : anchor ? anchor.index + (delta < 0 ? -1 : 0) : 0;
    const index = Math.max(0, Math.min(entries.length - 1, next));
    const key = getItemKey(index);
    focusAnchor.current = { key, index };
    if (virtualized) virtualizer.scrollToIndex(index);
    const entry = entries[index];
    if (entry.email) onSelectEmail?.(entry.email);
    requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector(`[data-explorer-index="${index}"]`);
      if (target?.dataset.explorerKey !== String(key)) return;
      const focusTarget = target?.querySelector('[data-testid="explorer-group-open"]') || target;
      focusTarget?.focus({ preventScroll: true });
      focusTarget?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [entries, getItemKey, virtualized, virtualizer, onSelectEmail]);
  useEffect(() => {
    const handle = event => step(event.detail);
    window.addEventListener('mailvault:explorer-step', handle);
    return () => window.removeEventListener('mailvault:explorer-step', handle);
  }, [step]);

  useEffect(() => {
    let timer;
    const scan = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (showGroups) return;
        const visible = virtualized ? virtualizer.getVirtualItems().map(item => entries[item.index]?.email).filter(Boolean)
          : visibleEmails.slice(0, 60);
        backfillTrackerVerdicts(visible);
      }, 400);
    };
    scan();
    const scroll = scrollRef.current;
    scroll?.addEventListener('scroll', scan, { passive: true });
    return () => { clearTimeout(timer); scroll?.removeEventListener('scroll', scan); };
  }, [showGroups, virtualized, virtualizer, entries, visibleEmails]);

  const unreadCount = visibleEmails.filter(isUnread).length;
  const vaultCount = visibleEmails.filter(email => email.isArchived).length;
  const groupLabel = group => group.id === tree.id ? rootLabel : group.label;

  return <section ref={rootRef} data-testid="explorer-view" data-grouping={grouping} className="mail-explorer"
    aria-label={t('explorer.name')} onKeyDown={event => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1); }
      if (event.key === 'ArrowLeft' && event.altKey && path.length) { event.preventDefault(); navigate(path.slice(0, -1)); }
      if (event.key === 'Enter' && event.target.hasAttribute('data-explorer-index')) {
        const email = entries[Number(event.target.dataset.explorerIndex)]?.email;
        if (email) { event.preventDefault(); onSelectEmail?.(email); }
      }
    }}>
    <div className="explorer-controls">
      <label>{t('explorer.browseBy')}<select data-testid="explorer-grouping" aria-label={t('explorer.browseBy')}
        value={grouping} onChange={event => setGrouping(event.target.value)}>
        <option value="date">{t('explorer.date')}</option><option value="sender">{t('explorer.sender')}</option>
        <option value="conversation">{t('explorer.conversation')}</option>
      </select></label>
      <label>{t('explorer.dateDepth')}<select aria-label={t('explorer.dateDepth')} value={dateDepth} onChange={event => setDateDepth(event.target.value)}>
        <option value="month">{t('explorer.month')}</option><option value="day">{t('explorer.day')}</option>
      </select></label>
    </div>
    <nav className="explorer-breadcrumbs" aria-label={t('explorer.path')}>
      <button type="button" data-testid="explorer-back" className="mail-toolbar-button" disabled={!path.length}
        aria-label={t('explorer.back')} onClick={() => navigate(path.slice(0, -1))}><ArrowLeft size={16} /></button>
      {breadcrumbs.map((group, index) => <React.Fragment key={group.id}>
        {index > 0 && <ChevronRight size={12} className="shrink-0 text-mail-text-muted" aria-hidden="true" />}
        <button type="button" className="explorer-crumb" aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}
          onClick={() => navigate(path.slice(0, index))} title={groupLabel(group)} dir="auto">{displayText(groupLabel(group))}</button>
      </React.Fragment>)}
    </nav>
    <div className="explorer-search">
      <Search size={14} aria-hidden="true" />
      <input type="search" data-testid="explorer-search" aria-label={t('explorer.searchGroup')} placeholder={t('explorer.searchGroup')}
        value={query} onChange={event => setSearch({ location, value: event.target.value })} />
      {query && <button type="button" className="mail-toolbar-button" aria-label={t('explorer.clearSearch')}
        onClick={() => setSearch({ location, value: '' })}><X size={14} /></button>}
      {onSearchMailbox && <button type="button" className="explorer-mailbox-search" onClick={onSearchMailbox}>{t('explorer.searchMailbox')}</button>}
    </div>
    <div className="explorer-summary">
      <GroupCheckbox emails={visibleEmails} selectedEmailIds={selectedEmailIds} getSelectionKey={getSelectionKey}
        onSetSelection={onSetSelection} label={t('explorer.selectVisible')} />
      <span aria-live="polite">{showGroups && <>{t('explorer.groupCount', { count: entries.length })} · </>}
        {t(normalizedQuery ? 'explorer.matches' : 'common.emailCount', { count: visibleEmails.length })}
        {unreadCount > 0 && <> · {t('explorer.unreadCount', { count: unreadCount })}</>}</span>
      {node.thread && onOpenThread && <button type="button" data-testid="explorer-open-thread" className="explorer-mailbox-search"
        onClick={() => onOpenThread(node.thread)}>{t('explorer.openThread')}</button>}
    </div>
    <div ref={scrollRef} data-testid="explorer-scroll" className="explorer-scroll">
      {entries.length === 0 ? <p data-testid="explorer-empty" className="explorer-empty">
        {t(loading ? 'explorer.loading' : normalizedQuery ? 'explorer.noMatches' : unreadOnly ? 'explorer.noUnread' : 'explorer.empty')}</p>
        : <div style={virtualized ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
          {items.map(item => {
            const entry = entries[item.index];
            const group = entry.group;
            const selected = group && entry.emails.every(email => selectedEmailIds.has(getSelectionKey(email)));
            const rememberFocus = () => { focusAnchor.current = { key: item.key, index: item.index }; };
            const props = { key: item.key, 'data-explorer-index': item.index, 'data-explorer-key': String(item.key),
              onClickCapture: rememberFocus, onFocusCapture: rememberFocus,
              style: virtualized ? { position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }
                : !group ? { position: 'relative', height: rowHeight } : undefined };
            if (!group) return <div {...props} tabIndex={-1}>{renderEmail(entry.email)}</div>;
            const GroupIcon = group.thread ? MessagesSquare : Folder;
            return <div {...props} data-testid="explorer-group-row" data-label={group.label} data-detail={group.detail}
              data-selected={selected || undefined} className="explorer-group-row">
              <GroupCheckbox emails={entry.emails} selectedEmailIds={selectedEmailIds} getSelectionKey={getSelectionKey}
                onSetSelection={onSetSelection} label={t('explorer.selectGroup', { name: group.label })} />
              <button type="button" data-testid="explorer-group-open" className="explorer-group-open"
                aria-label={t('explorer.openGroup', { name: group.label })}
                onClick={() => navigate([...path, group.id])}>
                <GroupIcon size={20} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
                <span className="explorer-group-copy"><span className="explorer-group-name" dir="auto" title={group.label}>{displayText(group.label)}</span>
                  <span className="explorer-group-meta">{group.detail && <span className="explorer-sender-address" dir="auto" title={group.detail}>{displayText(group.detail)} · </span>}
                    {t('common.emailCount', { count: entry.emails.length })} · {t('explorer.vaultCount', { count: entry.emails.filter(email => email.isArchived).length })}
                    {entry.emails.some(isUnread) && <> · {t('explorer.unreadCount', { count: entry.emails.filter(isUnread).length })}</>}
                  </span>
                </span>
                <span className="explorer-group-date">{group.lastDate ? formatEmailDate(group.lastDate) : ''}</span>
                <ChevronRight size={14} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
              </button>
            </div>;
          })}
        </div>}
    </div>
    <footer className="explorer-footer">
      <span>{t('explorer.vaultCount', { count: vaultCount })}{selectedEmailIds.size > 0 && <> · {t('explorer.selected', { count: selectedEmailIds.size })}</>}</span>
      {partial && <span data-testid="explorer-partial">{t(hasMore ? 'explorer.partial' : 'explorer.partialUnavailable')}</span>}
      {hasMore && onLoadMore && <button type="button" className="mail-toolbar-button" disabled={loadingMore} onClick={onLoadMore}>
        {t(loadingMore ? 'explorer.loading' : 'explorer.loadMore')}</button>}
    </footer>
  </section>;
}
