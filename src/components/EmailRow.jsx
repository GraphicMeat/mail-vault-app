import React from 'react';
import { getAccountColor } from '../stores/settingsStore';
import { getSenderName } from '../utils/emailParser';
import { getCachedAlerts } from '../utils/linkSafety';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon } from './SenderAlertIcon';
import { ReplyToAlertIcon } from './ReplyToAlertIcon';
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

export const EmailRow = React.memo(function EmailRow({ email, isSelected, onSelect, onToggleSelection, isChecked, style, actions, unifiedInbox, accountColors, menuOpen, confirmingDelete, onOpenMenu, onCloseMenu, onConfirmDelete, isSaving, onStartSaving, onStopSaving }) {
  const { saveEmailLocally, removeLocalEmail, deleteEmailFromServer } = actions;

  const handleSave = async (e) => {
    e.stopPropagation();
    onStartSaving();
    try {
      await saveEmailLocally(email.uid);
    } finally {
      onStopSaving();
    }
  };

  const handleRemoveLocal = async (e) => {
    e.stopPropagation();
    await removeLocalEmail(email.uid);
    onCloseMenu();
  };

  const handleDeleteServer = (e) => {
    e.stopPropagation();
    if (confirmingDelete) {
      deleteEmailFromServer(email.uid);
      onCloseMenu();
    } else {
      onConfirmDelete();
    }
  };

  const isUnread = !email.flags?.includes('\\Seen');

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-3 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !isChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${isUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelect(email.uid, email.source)}
    >
      <div onClick={(e) => { e.stopPropagation(); onToggleSelection(email.uid, email._accountId); }}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          className="custom-checkbox"
        />
      </div>

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        {email.source === 'local-only' ? (
          <div title="Local only (deleted from server)">
            <HardDrive size={14} className="text-mail-warning" />
          </div>
        ) : email.isArchived ? (
          <div title="Archived">
            <HardDrive size={14} className="text-mail-local" />
          </div>
        ) : (
          <Cloud size={14} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      <div className={`w-48 min-w-[80px] truncate flex-shrink flex items-center gap-1.5 ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {unifiedInbox && email._accountEmail && (
          <span
            data-testid="account-dot"
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
            title={email._accountEmail}
          />
        )}
        <span className="truncate">{getSenderName(email)}</span>
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <SenderAlertIcon level={email._senderAlert} email={email} />
        <ReplyToAlertIcon mismatch={email._replyToMismatch} />
        <LinkAlertIcon level={email._linkAlert} alerts={getCachedAlerts(email.uid)} />
        <span className={`truncate ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {email.subject}
        </span>
        {email.hasAttachments && (
          <Paperclip size={14} className="text-mail-text-muted flex-shrink-0" />
        )}
        <span className="ml-auto text-xs text-mail-text-muted whitespace-nowrap flex-shrink-0">
          {formatEmailDate(email.date)}
        </span>
      </div>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible bg-mail-surface-hover rounded-md px-1">
        {!email.isArchived && (
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
            title="Archive"
          >
            {isSaving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent" />
            ) : (
              <Archive size={14} className="text-mail-text-muted hover:text-mail-local" />
            )}
          </button>
        )}

        <RowActionMenu open={menuOpen} onOpen={onOpenMenu} onClose={onCloseMenu}>
          {email.isArchived && (
            <button
              onClick={handleRemoveLocal}
              className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                        flex items-center gap-2 text-mail-text"
            >
              <Archive size={14} />
              Unarchive
            </button>
          )}
          {email.source !== 'local-only' && (
            <button
              onClick={handleDeleteServer}
              className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                        flex items-center gap-2 ${confirmingDelete ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}
            >
              <Trash2 size={14} />
              {confirmingDelete ? 'Confirm delete?' : 'Delete from server'}
            </button>
          )}
        </RowActionMenu>
      </div>
    </div>
  );
});

export const CompactEmailRow = React.memo(function CompactEmailRow({ email, isSelected, onSelect, onToggleSelection, isChecked, style, actions, unifiedInbox, accountColors, menuOpen, confirmingDelete, onOpenMenu, onCloseMenu, onConfirmDelete, isSaving, onStartSaving, onStopSaving }) {
  const { saveEmailLocally, removeLocalEmail, deleteEmailFromServer } = actions;

  const handleSave = async (e) => {
    e.stopPropagation();
    onStartSaving();
    try { await saveEmailLocally(email.uid); } finally { onStopSaving(); }
  };

  const handleRemoveLocal = async (e) => {
    e.stopPropagation();
    await removeLocalEmail(email.uid);
    onCloseMenu();
  };

  const handleDeleteServer = (e) => {
    e.stopPropagation();
    if (confirmingDelete) {
      deleteEmailFromServer(email.uid);
      onCloseMenu();
    } else {
      onConfirmDelete();
    }
  };

  const isUnread = !email.flags?.includes('\\Seen');

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-2 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !isChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${isUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelect(email.uid, email.source)}
    >
      <div onClick={(e) => { e.stopPropagation(); onToggleSelection(email.uid, email._accountId); }}>
        <input type="checkbox" checked={isChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      {/* Source icon */}
      <div className="w-4 flex items-center justify-center flex-shrink-0">
        {email.source === 'local-only' ? (
          <HardDrive size={13} className="text-mail-warning" title="Local only" />
        ) : email.isArchived ? (
          <HardDrive size={13} className="text-mail-local" title="Archived" />
        ) : (
          <Cloud size={13} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      {/* Two-line content */}
      <div className="flex-1 min-w-0 py-1.5">
        {/* Line 1: Sender ... Date */}
        <div className="flex items-center gap-2">
          {unifiedInbox && email._accountEmail && (
            <span
              data-testid="account-dot"
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
              title={email._accountEmail}
            />
          )}
          <span className={`truncate text-xs ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
            {getSenderName(email)}
          </span>
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            {formatEmailDate(email.date)}
          </span>
        </div>
        {/* Line 2: Subject + attachment */}
        <div className="flex items-center gap-1.5">
          <SenderAlertIcon level={email._senderAlert} email={email} size={12} />
          <ReplyToAlertIcon mismatch={email._replyToMismatch} size={12} />
          <LinkAlertIcon level={email._linkAlert} size={12} alerts={getCachedAlerts(email.uid)} />
          <span className={`truncate text-sm leading-snug ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {email.subject}
          </span>
          {email.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible bg-mail-surface-hover rounded-md px-1">
        {!email.isArchived && (
          <button onClick={handleSave} disabled={isSaving}
            className="p-1 hover:bg-mail-border rounded transition-colors" title="Archive">
            {isSaving ? <RefreshCw size={13} className="animate-spin text-mail-accent" />
              : <Archive size={13} className="text-mail-text-muted hover:text-mail-local" />}
          </button>
        )}
        <RowActionMenu open={menuOpen} onOpen={onOpenMenu} onClose={onCloseMenu} size={13}>
          {email.isArchived && (
            <button onClick={handleRemoveLocal}
              className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text">
              <Archive size={14} /> Unarchive
            </button>
          )}
          {email.source !== 'local-only' && (
            <button onClick={handleDeleteServer}
              className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 ${confirmingDelete ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}>
              <Trash2 size={14} /> {confirmingDelete ? 'Confirm delete?' : 'Delete from server'}
            </button>
          )}
        </RowActionMenu>
      </div>
    </div>
  );
});
