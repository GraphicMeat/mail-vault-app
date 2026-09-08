import React, { memo, useMemo, useState, useCallback, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useShallow } from 'zustand/react/shallow';
import {
  groupByCorrespondent,
  getAvatarColor,
  getInitials,
  formatRelativeTime
} from '../utils/emailParser';
import { MessageSquare, Search, ChevronRight } from 'lucide-react';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { useMailStore } from '../stores/mailStore';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';
import { useSettingsStore } from '../stores/settingsStore';
import { useT } from '../i18n/index.js';

const INITIAL_VISIBLE = 50;
const LOAD_MORE_COUNT = 50;

export function ChatSenderList({ onSelectSender }) {
  const t = useT();
  // getChatEmails already merges emails/localEmails/sentEmails internally
  const {
    getChatEmails,
    accounts,
    activeAccountId
  } = useAccountStore(
    useShallow(s => ({ getChatEmails: s.getChatEmails, accounts: s.accounts, activeAccountId: s.activeAccountId }))
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const scrollContainerRef = useRef(null);

  // Every address this account sends under — the login plus any send-as
  // override. Without the override the user's own sent mail reads as a
  // stranger's and gets grouped under the wrong correspondent.
  const sendAs = useSettingsStore(s => s.sendAsAddresses?.[activeAccountId] || '');
  const userEmail = useMemo(() => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    return [activeAccount?.email, sendAs].filter(Boolean);
  }, [accounts, activeAccountId, sendAs]);

  // Get merged emails — parent ChatViewWrapper subscribes to underlying state slices
  const combinedEmails = getChatEmails();

  // Group emails by correspondent
  const correspondents = useMemo(() => {
    const groups = groupByCorrespondent(combinedEmails, userEmail);

    // Convert to array and sort by last message date
    return Array.from(groups.values())
      .sort((a, b) => {
        const dateA = new Date(a.lastMessage?.date || 0);
        const dateB = new Date(b.lastMessage?.date || 0);
        return dateB - dateA; // Most recent first
      });
  }, [combinedEmails, userEmail]);

  // Filter by search
  const filteredCorrespondents = useMemo(() => {
    if (!searchQuery.trim()) return correspondents;

    const query = searchQuery.toLowerCase();
    return correspondents.filter(c =>
      c.name.toLowerCase().includes(query) ||
      c.email.toLowerCase().includes(query) ||
      c.lastMessage?.subject?.toLowerCase().includes(query)
    );
  }, [correspondents, searchQuery]);

  // Reset visible count when search query changes
  const prevSearchRef = useRef(searchQuery);
  if (prevSearchRef.current !== searchQuery) {
    prevSearchRef.current = searchQuery;
    if (visibleCount !== INITIAL_VISIBLE) setVisibleCount(INITIAL_VISIBLE);
  }

  // Slice to visible count for incremental rendering
  const visibleCorrespondents = useMemo(() => {
    return filteredCorrespondents.slice(0, visibleCount);
  }, [filteredCorrespondents, visibleCount]);

  const hasMore = visibleCount < filteredCorrespondents.length;

  // Load more senders when scrolled near bottom
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !hasMore) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 200) {
      setVisibleCount(prev => Math.min(prev + LOAD_MORE_COUNT, filteredCorrespondents.length));
    }
  }, [hasMore, filteredCorrespondents.length]);

  if (correspondents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-mail-text-muted p-8">
        <MessageSquare size={48} className="mb-4 opacity-50" />
        <p className="text-center">{t('chat.senders.noConversationsYet')}</p>
        <p className="text-sm mt-2 text-center">
          {t('chat.senders.emailConversationsWillAppearHere')}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="chat-sender-list" className="flex flex-col h-full min-h-0">
      <div data-tauri-drag-region className="border-b border-mail-border bg-mail-surface">
        <div className="chat-content-column px-6 py-5">
          <h2 className="text-lg font-semibold text-mail-text">{t('workspace.conversations')}</h2>
          <p className="mt-1 text-sm text-mail-text-muted">{t('workspace.conversationsHint')}</p>
          <div className="relative mt-4 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted" />
            <input type="search" data-testid="mail-search-input" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              aria-label={t('chat.senders.searchConversations')} placeholder={t('chat.senders.searchConversations')}
              className="w-full pl-9 pr-4 py-2 bg-mail-bg border border-mail-border-strong rounded-lg text-mail-text placeholder-mail-text-muted text-sm" />
          </div>
        </div>
      </div>

      {/* Sender List */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto min-h-0">
        <div className="chat-content-column">
        {filteredCorrespondents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-mail-text-muted">
            <p className="text-sm">{t('chat.senders.noMatchesFound')}</p>
          </div>
        ) : (
          <>
            {visibleCorrespondents.map(correspondent => (
              <SenderRow
                key={correspondent.email}
                correspondent={correspondent}
                onClick={() => onSelectSender(correspondent)}
              />
            ))}
            {hasMore && (
              <div className="py-3 text-center text-xs text-mail-text-muted">
                {t('chat.senders.loadingMore')}
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

const SenderRow = memo(function SenderRow({ correspondent, onClick }) {
  const avatarColor = getAvatarColor(correspondent.email);
  const initials = getInitials(correspondent.name, correspondent.email);

  return (
    <div
      data-testid="sender-row"
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      onClick={onClick}
      className="flex items-center gap-3 px-6 py-4 border-b border-mail-border
                cursor-pointer hover:bg-mail-surface-hover transition-colors"
    >
      {/* Avatar */}
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0"
        style={{ backgroundColor: avatarColor }}
      >
        {initials}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-mail-text truncate">
            {correspondent.name}
          </span>
          <span className="text-xs text-mail-text-muted flex-shrink-0">
            {correspondent.lastMessage && formatRelativeTime(correspondent.lastMessage.date)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-sm text-mail-text-muted truncate flex items-center gap-1">
            {(() => { const sa = getSenderAlertLevel(correspondent.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} size={12} /> : null; })()}
            <LinkAlertIcon level={getLinkAlertLevel(correspondent.emails)} size={12} alerts={getAlertsForEmails(correspondent.emails, useMailStore.getState())} />
            {correspondent.lastMessage?.subject || 'No messages'}
          </span>

          {correspondent.unreadCount > 0 && (
            <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 bg-mail-accent-fill rounded-full
                          text-white text-xs font-medium flex items-center justify-center">
              {correspondent.unreadCount > 99 ? '99+' : correspondent.unreadCount}
            </span>
          )}
        </div>

        {correspondent.lastMessage?.preview && (
          <p className="text-xs text-mail-text-muted truncate mt-1">
            {correspondent.lastMessage.preview}
          </p>
        )}
      </div>
      <ChevronRight size={16} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
    </div>
  );
});
