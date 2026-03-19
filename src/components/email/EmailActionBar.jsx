import React, { memo } from 'react';
import { Reply, ReplyAll, Forward, Archive, Trash2, FolderInput, MailOpen, Mail, ExternalLink, Code } from 'lucide-react';
import { motion } from 'framer-motion';
import { useSettingsStore } from '../../stores/settingsStore';

function ActionButton({ icon: Icon, label, onClick, disabled, isDestructive, compact }) {
  const actionButtonDisplay = useSettingsStore(s => s.actionButtonDisplay);
  const isIconOnly = actionButtonDisplay === 'icon-only';
  const isTextOnly = actionButtonDisplay === 'text-only';

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      disabled={disabled}
      title={isIconOnly ? label : undefined}
      aria-label={isIconOnly ? label : undefined}
      className={`flex items-center gap-1.5 ${compact ? 'px-2 py-1' : 'px-3 py-1.5'} text-xs text-mail-text-muted
                  bg-transparent hover:bg-mail-surface-hover border border-transparent hover:border-mail-border
                  rounded-lg transition-colors disabled:opacity-50
                  ${isDestructive ? 'hover:text-mail-danger' : 'hover:text-mail-text'}`}
    >
      {!isTextOnly && <Icon size={14} />}
      {!isIconOnly && <span>{label}</span>}
    </button>
  );
}

export const EmailActionBar = memo(function EmailActionBar({
  email,
  variant = 'single',
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
  onMove,
  onToggleRead,
  onOpenInWindow,
  onViewSource,
  isArchived,
  isRead,
  isLocalOnly,
  isSentEmail,
  singleRecipient,
  disabled = {},
  moveDropdownOpen,
  moveButtonRef,
}) {
  const isChat = variant === 'chat';
  const isThread = variant === 'thread';
  const compact = isChat;

  const buttons = (
    <>
      {/* Reply */}
      {!isSentEmail && (
        <ActionButton
          icon={Reply}
          label="Reply"
          onClick={() => onReply?.(email)}
          compact={compact}
        />
      )}

      {/* Reply All */}
      {!isSentEmail && !singleRecipient && (
        <ActionButton
          icon={ReplyAll}
          label="Reply All"
          onClick={() => onReplyAll?.(email)}
          compact={compact}
        />
      )}

      {/* Forward */}
      <ActionButton
        icon={Forward}
        label="Forward"
        onClick={() => onForward?.(email)}
        compact={compact}
      />

      {/* Archive */}
      {(!isLocalOnly || isArchived) && (
        <ActionButton
          icon={Archive}
          label={isArchived ? 'Unarchive' : 'Archive'}
          onClick={() => onArchive?.(email)}
          disabled={disabled.archive}
          compact={compact}
        />
      )}

      {/* Delete */}
      <ActionButton
        icon={Trash2}
        label="Delete"
        onClick={() => onDelete?.(email)}
        disabled={disabled.delete}
        isDestructive
        compact={compact}
      />

      {/* Move */}
      {!isLocalOnly && (
        <ActionButton
          icon={FolderInput}
          label="Move"
          onClick={() => onMove?.(email)}
          disabled={disabled.move}
          compact={compact}
        />
      )}

      {/* Toggle read */}
      {!isLocalOnly && (
        <ActionButton
          icon={isRead ? Mail : MailOpen}
          label={isRead ? 'Mark unread' : 'Mark read'}
          onClick={() => onToggleRead?.(email)}
          disabled={disabled.toggleRead}
          compact={compact}
        />
      )}

      {/* Open in window */}
      <ActionButton
        icon={ExternalLink}
        label="Open"
        onClick={() => onOpenInWindow?.(email)}
        compact={compact}
      />

      {/* View source */}
      <ActionButton
        icon={Code}
        label="Source"
        onClick={() => onViewSource?.(email)}
        compact={compact}
      />
    </>
  );

  // Chat variant: animated wrapper, no separator
  if (isChat) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.15 }}
        className="flex flex-wrap items-center gap-2 mt-1"
      >
        {buttons}
      </motion.div>
    );
  }

  // Single and thread variants: separator + buttons
  return (
    <div className={`flex flex-wrap items-center gap-2 border-t border-mail-border mt-3 pt-3${isThread ? ' pl-9' : ''}`}>
      {buttons}
    </div>
  );
});
