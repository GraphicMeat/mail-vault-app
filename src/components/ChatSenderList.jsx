import React, { useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion } from 'framer-motion';
import {
  groupByCorrespondent,
  getAvatarColor,
  getInitials,
  formatRelativeTime
} from '../utils/emailParser';
import { MessageSquare, Search } from 'lucide-react';

export function ChatSenderList({ onSelectSender }) {
  // Subscribe to all state values that affect email display to ensure re-renders
  const {
    getChatEmails,
    accounts,
    activeAccountId,
    emails,        // Subscribe to trigger re-render when server emails change
    localEmails,   // Subscribe to trigger re-render when local emails change
    sentEmails,    // Subscribe to trigger re-render when sent emails load
    viewMode       // Subscribe to trigger re-render when view mode changes
  } = useMailStore();
  const [searchQuery, setSearchQuery] = React.useState('');

  // Get current user's email
  const userEmail = useMemo(() => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    return activeAccount?.email || '';
  }, [accounts, activeAccountId]);

  // Get emails directly - subscribing to emails/localEmails/sentEmails/viewMode above ensures this updates
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
    <div className="flex flex-col h-full">
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
      <div className="flex-1 overflow-y-auto">
        {filteredCorrespondents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-mail-text-muted">
            <p className="text-sm">No matches found</p>
          </div>
        ) : (
          filteredCorrespondents.map((correspondent, index) => (
            <SenderRow
              key={correspondent.email}
              correspondent={correspondent}
              onClick={() => onSelectSender(correspondent)}
              index={index}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SenderRow({ correspondent, onClick, index }) {
  const avatarColor = getAvatarColor(correspondent.email);
  const initials = getInitials(correspondent.name, correspondent.email);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
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
          <span className="text-sm text-mail-text-muted truncate">
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
}
