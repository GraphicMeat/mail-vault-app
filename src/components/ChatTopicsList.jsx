import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  buildThreads,
  getAvatarColor,
  getInitials,
  formatRelativeTime
} from '../utils/emailParser';
import { ChevronLeft, MessageCircle, Calendar } from 'lucide-react';
import { format } from 'date-fns';

export function ChatTopicsList({ correspondent, onBack, onSelectTopic }) {
  const avatarColor = getAvatarColor(correspondent.email);
  const initials = getInitials(correspondent.name, correspondent.email);

  // Group emails into threads using RFC header chains + subject fallback
  const topics = useMemo(() => {
    const threads = buildThreads(correspondent.emails);

    // Convert to array and sort by most recent message
    return Array.from(threads.values())
      .sort((a, b) => {
        const dateA = a.dateRange.end || new Date(0);
        const dateB = b.dateRange.end || new Date(0);
        return dateB - dateA;
      });
  }, [correspondent.emails]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div data-tauri-drag-region className="flex items-center gap-2.5 px-4 py-[13px] border-b border-mail-border bg-mail-surface">
        <button
          onClick={onBack}
          className="p-1 hover:bg-mail-border rounded-lg transition-colors"
        >
          <ChevronLeft size={18} className="text-mail-text-muted" />
        </button>

        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0"
          style={{ backgroundColor: avatarColor }}
        >
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-mail-text truncate leading-tight">
            {correspondent.name}
          </h2>
          <p className="text-[11px] text-mail-text-muted truncate leading-tight">
            {correspondent.email}
          </p>
        </div>

        <div className="text-right text-[11px] text-mail-text-muted">
          <p>{correspondent.emails.length} messages</p>
          <p>{topics.length} topics</p>
        </div>
      </div>

      {/* Topics List */}
      <div className="flex-1 overflow-y-auto">
        {topics.map((topic, index) => (
          <TopicRow
            key={topic.threadId}
            topic={topic}
            onClick={() => onSelectTopic(topic)}
            index={index}
          />
        ))}
      </div>
    </div>
  );
}

function TopicRow({ topic, onClick, index }) {
  const unreadCount = topic.emails.filter(e => !e.flags?.includes('\\Seen')).length;
  const hasAttachments = topic.emails.some(e => e.hasAttachments);

  const dateRangeText = useMemo(() => {
    if (!topic.dateRange.start || !topic.dateRange.end) return '';

    const start = topic.dateRange.start;
    const end = topic.dateRange.end;

    // Same day
    if (start.toDateString() === end.toDateString()) {
      return format(end, 'MMM d');
    }

    // Different days
    return `${format(start, 'MMM d')} - ${format(end, 'MMM d')}`;
  }, [topic.dateRange]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
      onClick={onClick}
      className="flex items-start gap-3 px-4 py-3 border-b border-mail-border
                cursor-pointer hover:bg-mail-surface-hover transition-colors"
    >
      {/* Topic Icon */}
      <div className="w-10 h-10 rounded-lg bg-mail-accent/10 flex items-center justify-center flex-shrink-0">
        <MessageCircle size={20} className="text-mail-accent" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h3 className={`truncate ${unreadCount > 0 ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {topic.subject}
          </h3>

          {unreadCount > 0 && (
            <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 bg-mail-accent rounded-full
                          text-white text-xs font-medium flex items-center justify-center">
              {unreadCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 mt-1 text-xs text-mail-text-muted">
          <span className="flex items-center gap-1">
            <MessageCircle size={12} />
            {topic.emails.length} message{topic.emails.length !== 1 ? 's' : ''}
          </span>

          {dateRangeText && (
            <span className="flex items-center gap-1">
              <Calendar size={12} />
              {dateRangeText}
            </span>
          )}

          {hasAttachments && (
            <span className="text-mail-accent">Has attachments</span>
          )}
        </div>
      </div>

      {/* Arrow */}
      <ChevronLeft size={16} className="text-mail-text-muted rotate-180 flex-shrink-0 mt-1" />
    </motion.div>
  );
}
