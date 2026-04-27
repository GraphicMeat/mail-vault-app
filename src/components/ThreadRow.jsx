import React, { useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { getSenderName } from '../utils/emailParser';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';
import { ReplyToAlertIcon, getThreadReplyToMismatch } from './ReplyToAlertIcon';
import { RowActionMenu } from './RowActionMenu';
import { formatEmailDate } from '../utils/dateFormat';
import {
  RefreshCw,
  HardDrive,
  Cloud,
  Paperclip,
  Trash2,
  Archive,
} from 'lucide-react';

// Thread row for default layout — shows collapsed thread with participant names and count
export const ThreadRow = React.memo(function ThreadRow({ thread, isSelected, onSelectThread, onToggleSelection, anyChecked, style, actions, menuOpen, confirmingDelete, onOpenMenu, onCloseMenu, onConfirmDelete, isSaving, onStartSaving, onStopSaving }) {
  const { saveEmailsLocally, deleteEmailFromServer } = actions;

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;
  const allArchived = thread.emails.every(e => e.isArchived);

  // Build participant display: show sender names (not the user)
  const participantNames = useMemo(() => {
    const seen = new Set();
    const names = [];
    for (const email of thread.emails) {
      const name = getSenderName(email);
      const addr = email.from?.address?.toLowerCase() || '';
      if (!seen.has(addr)) {
        seen.add(addr);
        names.push(name);
      }
    }
    return names.length <= 2 ? names.join(', ') : `${names[0]}, ${names[1]} +${names.length - 2}`;
  }, [thread.emails]);

  const handleArchiveThread = async (e) => {
    e.stopPropagation();
    onStartSaving();
    try {
      const uids = thread.emails.filter(em => !em.isArchived).map(em => em.uid);
      if (uids.length > 0) await saveEmailsLocally(uids);
    } finally {
      onStopSaving();
    }
  };

  const handleDeleteThread = async (e) => {
    e.stopPropagation();
    if (!confirmingDelete) {
      onConfirmDelete();
      return;
    }
    const serverEmails = thread.emails.filter(em => em.source !== 'local-only');
    const activeMailbox = useMailStore.getState().activeMailbox;
    const sentPath = useMailStore.getState().getSentMailboxPath();
    for (const email of serverEmails) {
      const mailbox = email._fromSentFolder && sentPath ? sentPath : activeMailbox;
      try {
        await deleteEmailFromServer(email.uid, { skipRefresh: true, mailboxOverride: mailbox });
      } catch (err) {
        console.error(`[handleDeleteThread] Failed to delete email ${email.uid} from ${mailbox}:`, err);
      }
    }
    if (serverEmails.length > 0) useMailStore.getState().loadEmails();
    onCloseMenu();
  };

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-3 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !anyChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${hasUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelectThread(thread)}
    >
      <div onClick={(e) => { e.stopPropagation(); thread.emails.forEach(em => onToggleSelection(em.uid, em._accountId)); }}>
        <input type="checkbox" checked={anyChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        {latestEmail.source === 'local-only' ? (
          <HardDrive size={14} className="text-mail-warning" title="Local only" />
        ) : latestEmail.isArchived ? (
          <HardDrive size={14} className="text-mail-local" title="Archived" />
        ) : (
          <Cloud size={14} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      <div className={`w-48 min-w-[80px] truncate flex-shrink ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {participantNames}
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        {(() => { const sa = getSenderAlertLevel(thread.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} /> : null; })()}
        <ReplyToAlertIcon mismatch={getThreadReplyToMismatch(thread.emails)} />
        <LinkAlertIcon level={getLinkAlertLevel(thread.emails)} alerts={getAlertsForEmails(thread.emails)} />
        <span className={`truncate ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {thread.subject}
        </span>
        {thread.messageCount > 1 && (
          <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 bg-mail-text-muted/15 rounded-full
                        text-mail-text-muted text-xs font-medium flex items-center justify-center">
            {thread.messageCount}
          </span>
        )}
        {latestEmail.hasAttachments && (
          <Paperclip size={14} className="text-mail-text-muted flex-shrink-0" />
        )}
        <span className="ml-auto text-xs text-mail-text-muted whitespace-nowrap flex-shrink-0">
          {formatEmailDate(latestEmail.date)}
        </span>
      </div>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible bg-mail-surface-hover rounded-md px-1">
        {!allArchived && (
          <button
            onClick={handleArchiveThread}
            disabled={isSaving}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
            title="Archive thread"
          >
            {isSaving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent" />
            ) : (
              <Archive size={14} className="text-mail-text-muted hover:text-mail-local" />
            )}
          </button>
        )}

        <RowActionMenu open={menuOpen} onOpen={onOpenMenu} onClose={onCloseMenu}>
          <button
            onClick={handleDeleteThread}
            className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                      flex items-center gap-2 ${confirmingDelete ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}
          >
            <Trash2 size={14} />
            {confirmingDelete ? `Delete ${thread.messageCount} emails?` : 'Delete thread from server'}
          </button>
        </RowActionMenu>
      </div>
    </div>
  );
});

// Compact thread row for compact layout
export const CompactThreadRow = React.memo(function CompactThreadRow({ thread, isSelected, onSelectThread, onToggleSelection, anyChecked, style, actions, menuOpen, confirmingDelete, onOpenMenu, onCloseMenu, onConfirmDelete, isSaving, onStartSaving, onStopSaving }) {
  const { saveEmailsLocally, deleteEmailFromServer } = actions;

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;
  const allArchived = thread.emails.every(e => e.isArchived);

  const participantNames = useMemo(() => {
    const seen = new Set();
    const names = [];
    for (const email of thread.emails) {
      const name = getSenderName(email);
      const addr = email.from?.address?.toLowerCase() || '';
      if (!seen.has(addr)) {
        seen.add(addr);
        names.push(name);
      }
    }
    return names.length <= 2 ? names.join(', ') : `${names[0]}, ${names[1]} +${names.length - 2}`;
  }, [thread.emails]);

  const handleArchiveThread = async (e) => {
    e.stopPropagation();
    onStartSaving();
    try {
      const uids = thread.emails.filter(em => !em.isArchived).map(em => em.uid);
      if (uids.length > 0) await saveEmailsLocally(uids);
    } finally {
      onStopSaving();
    }
  };

  const handleDeleteThread = async (e) => {
    e.stopPropagation();
    if (!confirmingDelete) {
      onConfirmDelete();
      return;
    }
    const serverEmails = thread.emails.filter(em => em.source !== 'local-only');
    const activeMailbox = useMailStore.getState().activeMailbox;
    const sentPath = useMailStore.getState().getSentMailboxPath();
    for (const email of serverEmails) {
      const mailbox = email._fromSentFolder && sentPath ? sentPath : activeMailbox;
      try {
        await deleteEmailFromServer(email.uid, { skipRefresh: true, mailboxOverride: mailbox });
      } catch (err) {
        console.error(`Failed to delete email ${email.uid} from ${mailbox}:`, err);
      }
    }
    if (serverEmails.length > 0) useMailStore.getState().loadEmails();
    onCloseMenu();
  };

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-2 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !anyChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${hasUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelectThread(thread)}
    >
      <div onClick={(e) => { e.stopPropagation(); thread.emails.forEach(em => onToggleSelection(em.uid, em._accountId)); }}>
        <input type="checkbox" checked={anyChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      <div className="w-4 flex items-center justify-center flex-shrink-0">
        {latestEmail.source === 'local-only' ? (
          <HardDrive size={13} className="text-mail-warning" title="Local only" />
        ) : latestEmail.isArchived ? (
          <HardDrive size={13} className="text-mail-local" title="Archived" />
        ) : (
          <Cloud size={13} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      <div className="flex-1 min-w-0 py-1.5">
        <div className="flex items-center gap-2">
          <span className={`truncate text-xs ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
            {participantNames}
          </span>
          {thread.messageCount > 1 && (
            <span className="flex-shrink-0 min-w-[16px] h-4 px-1 bg-mail-text-muted/15 rounded-full
                          text-mail-text-muted text-[10px] font-medium flex items-center justify-center">
              {thread.messageCount}
            </span>
          )}
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            {formatEmailDate(latestEmail.date)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {(() => { const sa = getSenderAlertLevel(thread.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} size={12} /> : null; })()}
          <ReplyToAlertIcon mismatch={getThreadReplyToMismatch(thread.emails)} size={12} />
          <LinkAlertIcon level={getLinkAlertLevel(thread.emails)} size={12} alerts={getAlertsForEmails(thread.emails)} />
          <span className={`truncate text-sm leading-snug ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {thread.subject}
          </span>
          {latestEmail.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible bg-mail-surface-hover rounded-md px-1">
        {!allArchived && (
          <button onClick={handleArchiveThread} disabled={isSaving}
            className="p-1 hover:bg-mail-border rounded transition-colors" title="Archive thread">
            {isSaving ? <RefreshCw size={13} className="animate-spin text-mail-accent" />
              : <Archive size={13} className="text-mail-text-muted hover:text-mail-local" />}
          </button>
        )}
        <RowActionMenu open={menuOpen} onOpen={onOpenMenu} onClose={onCloseMenu} size={13}>
          <button onClick={handleDeleteThread}
            className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 ${confirmingDelete ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}>
            <Trash2 size={14} /> {confirmingDelete ? `Delete ${thread.messageCount} emails?` : 'Delete thread from server'}
          </button>
        </RowActionMenu>
      </div>
    </div>
  );
});
