import React, { memo, useMemo, useState, useCallback, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useShallow } from 'zustand/react/shallow';
import { motion } from 'framer-motion';
import {
  groupByCorrespondent,
  getAvatarColor,
  getInitials,
  formatRelativeTime
} from '../utils/emailParser';
import { MessageSquare, Search } from 'lucide-react';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';

const INITIAL_VISIBLE = 50;
const LOAD_MORE_COUNT = 50;

export function ChatSenderList({ onSelectSender }) {
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

  // Get current user's email
  const userEmail = useMemo(() => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    return activeAccount?.email || '';
  }, [accounts, activeAccountId]);

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
        <p className="text-center">No conversations yet</p>
        <p className="text-sm mt-2 text-center">
          Your email conversations will appear here
        </p>
      </div>
    );
  }

  return (
    <div data-testid="chat-sender-list" className="flex flex-col h-full">
      {/* Search Bar — matches sidebar header height (px-4 py-3) */}
      <div data-tauri-drag-region className="px-4 py-3 border-b border-mail-border flex items-center">
        <div className="relative w-full">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-9 pr-4 py-1.5 bg-mail-bg border border-mail-border rounded-lg
                      text-mail-text placeholder-mail-text-muted text-sm
                      focus:border-mail-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Sender List */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {filteredCorrespondents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-mail-text-muted">
            <p className="text-sm">No matches found</p>
          </div>
        ) : (
          <>
            {visibleCorrespondents.map((correspondent, index) => (
              <SenderRow
                key={correspondent.email}
                correspondent={correspondent}
                onClick={() => onSelectSender(correspondent)}
                index={index}
              />
            ))}
            {hasMore && (
              <div className="py-3 text-center text-xs text-mail-text-muted">
                Loading more...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const SenderRow = memo(function SenderRow({ correspondent, onClick, index }) {
  const avatarColor = getAvatarColor(correspondent.email);
  const initials = getInitials(correspondent.name, correspondent.email);

  return (
    <motion.div
      data-testid="sender-row"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0 }}
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-3 border-b border-mail-border
                cursor-pointer hover:bg-mail-surface-hover transition-colors"
    >
      {/* Avatar */}
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-lg flex-shrink-0"
        style={{ backgroundColor: avatarColor }}
      >
        {initials}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-mail-text truncate">
            {correspondent.name}
          </span>
          <span className="text-xs text-mail-text-muted flex-shrink-0">
            {correspondent.lastMessage && formatRelativeTime(correspondent.lastMessage.date)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-sm text-mail-text-muted truncate flex items-center gap-1">
            {(() => { const sa = getSenderAlertLevel(correspondent.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} size={12} /> : null; })()}
            <LinkAlertIcon level={getLinkAlertLevel(correspondent.emails)} size={12} alerts={getAlertsForEmails(correspondent.emails)} />
            {correspondent.lastMessage?.subject || 'No messages'}
          </span>

          {correspondent.unreadCount > 0 && (
            <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 bg-mail-accent rounded-full
                          text-white text-xs font-medium flex items-center justify-center">
              {correspondent.unreadCount > 99 ? '99+' : correspondent.unreadCount}
            </span>
          )}
        </div>

        {correspondent.lastMessage?.preview && (
          <p className="text-xs text-mail-text-muted truncate mt-0.5 opacity-70">
            {correspondent.lastMessage.preview}
          </p>
        )}
      </div>
    </motion.div>
  );
});
