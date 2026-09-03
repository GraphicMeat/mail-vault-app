import { Button } from './ui/Button';
import React, { useMemo } from 'react';
import { displayText } from '../utils/bidiText';
import { getSenderName, threadRowMembers } from '../utils/emailParser';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { useMailStore } from '../stores/mailStore';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';
import { ReplyToAlertIcon, getThreadReplyToMismatch } from './ReplyToAlertIcon';
import { TrackerAlertIcon, getThreadTrackerInfo } from './TrackerAlertIcon';
import { useSettingsStore, isTrackerBlockingActive } from '../stores/settingsStore';
import { RowActionMenu } from './RowActionMenu';
import { RowActionMenuItems } from './RowActionMenuItems';
import { formatEmailDate } from '../utils/dateFormat';
import { ConnectedStateIcon, describeMessageState } from './email/MessageStateIcon';
import { emailScopeKey } from '../stores/slices/unifiedHelpers';
import { useCustodyLanding } from '../hooks/useCustodyLanding';
import {
  RefreshCw,
  Paperclip,
  Archive,
  ChevronRight,
} from 'lucide-react';
import { t as tr, useT  } from '../i18n/index.js';

// The unfold control (expandable thread mode). Nothing when the mode is off,
// so grouped and flat rows keep the exact shape they had.
function ThreadDisclosure({ expandable, expanded, threadId, onToggleExpand }) {
  const t = useT();
  if (!expandable) return null;
  const label = expanded ? t('thread.hideReplies') : t('thread.showReplies');
  return (
    <button
      type="button"
      data-testid="thread-expand"
      aria-expanded={!!expanded}
      aria-label={label}
      title={label}
      className="w-5 h-5 -ml-1 flex items-center justify-center rounded flex-shrink-0 text-mail-text-muted hover:text-mail-text hover:bg-mail-border"
      onClick={(e) => { e.stopPropagation(); onToggleExpand(threadId); }}
    >
      <ChevronRight size={14} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </button>
  );
}

// Thread row for default layout — shows collapsed thread with participant names and count
export const ThreadRow = React.memo(function ThreadRow({ rowId, thread, isSelected, onSelectThread, onSetSelection, anyChecked, style, actions, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, isSaving, onStartSaving, onStopSaving, expandable, expanded, onToggleExpand }) {
  const t = useT();
  const handleOpenMenu = React.useCallback(() => onOpenMenu(rowId), [onOpenMenu, rowId]);
  const { saveEmailsLocally } = actions;

  // Hooks stay above the early return: a row that loses its lastEmail must not
  // shift the hook order underneath it. A thread's custody is its newest
  // message's custody, so that is what hands over.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const scopeKey = emailScopeKey(thread?.lastEmail, useMailStore.getState());
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const custodyTone = thread?.lastEmail
    ? describeMessageState(thread.lastEmail, { serverKnown }).tone
    : null;
  const landed = useCustodyLanding(scopeKey, custodyTone);

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;
  // Everything this row acts on — its checkbox, its menu, its archive button —
  // is the part of the thread that lives in the folder on screen, never the
  // Sent copies an INBOX list merges in for context. See threadRowMembers.
  const members = useMemo(() => threadRowMembers(thread.emails), [thread.emails]);
  const allArchived = members.every(e => e.isArchived);

  // Build participant display: every distinct sender in the thread, the user
  // included — a conversation you replied to shows your name too.
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
    onStartSaving(rowId);
    try {
      const rows = members.filter(em => !em.isArchived);
      if (rows.length > 0) await saveEmailsLocally(rows);
    } finally {
      onStopSaving(rowId);
    }
  };

  return (
    <div
      data-testid="email-row"
      data-thread-count={thread.messageCount}
      data-landed={landed || undefined}
      style={style}
      className={`virtual-row group relative flex items-center gap-3 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !anyChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${hasUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelectThread(thread)}
    >
      <div onClick={(e) => { e.stopPropagation(); onSetSelection(members, !anyChecked); }}>
        <input type="checkbox" checked={anyChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      <ThreadDisclosure expandable={expandable} expanded={expanded} threadId={thread.threadId} onToggleExpand={onToggleExpand} />

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        <ConnectedStateIcon email={latestEmail} size={14} />
      </div>

      <div className={`w-[32%] max-w-48 min-w-[80px] truncate flex-shrink ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {participantNames}
      </div>

      {/*
        Same shape as EmailRow: a real floor, not min-w-0, and flex-1 on the
        subject span. The participants column is `w-[32%] max-w-48` — a share
        of this row, capped at the 192px it has always been above ~600px — and
        it only gives up space once the flex line overflows. With min-w-0 here
        it never did, so this column took the whole deficit and the subject
        rendered at 0px while the count badge and date kept theirs.

        140px, not EmailRow's 120px: this row carries the message-count badge
        as well, and the badge plus its gap is the extra 20px. At a 350px pane
        that leaves the subject 42px against EmailRow's 50px; 150px would suit
        the default width better but starts overflowing at 320px.
      */}
      <div className="flex-1 min-w-[140px] flex items-center gap-2">
        {(() => { const sa = getSenderAlertLevel(thread.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} /> : null; })()}
        <ReplyToAlertIcon mismatch={getThreadReplyToMismatch(thread.emails)} />
        <LinkAlertIcon level={getLinkAlertLevel(thread.emails)} alerts={getAlertsForEmails(thread.emails, useMailStore.getState())} />
        <TrackerAlertIcon info={getThreadTrackerInfo(thread.emails)} blocked={trackerBlocking} />
        <span dir="auto" className={`flex-1 min-w-0 truncate ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {displayText(thread.subject, '(No subject)')}
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
          <Button variant="ghost" icon size="sm" className="press hover:bg-mail-border"
            onClick={handleArchiveThread}
            disabled={isSaving}
            title={t('thread.archiveThread')}
          >
            {isSaving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent-text" />
            ) : (
              <Archive size={14} className="text-mail-text-muted hover:text-mail-local" />
            )}
          </Button>
        )}

        <RowActionMenu open={menuOpen} onOpen={handleOpenMenu} onClose={onCloseMenu}>
          <RowActionMenuItems emails={members} actions={actions} onRequestDelete={onRequestDelete} onClose={onCloseMenu} />
        </RowActionMenu>
      </div>
    </div>
  );
});

// Compact thread row for compact layout
export const CompactThreadRow = React.memo(function CompactThreadRow({ rowId, thread, isSelected, onSelectThread, onSetSelection, anyChecked, style, actions, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, isSaving, onStartSaving, onStopSaving, expandable, expanded, onToggleExpand }) {
  const t = useT();
  const handleOpenMenu = React.useCallback(() => onOpenMenu(rowId), [onOpenMenu, rowId]);
  const { saveEmailsLocally } = actions;

  // Hooks stay above the early return: a row that loses its lastEmail must not
  // shift the hook order underneath it. A thread's custody is its newest
  // message's custody, so that is what hands over.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const scopeKey = emailScopeKey(thread?.lastEmail, useMailStore.getState());
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const custodyTone = thread?.lastEmail
    ? describeMessageState(thread.lastEmail, { serverKnown }).tone
    : null;
  const landed = useCustodyLanding(scopeKey, custodyTone);

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;
  // Everything this row acts on — its checkbox, its menu, its archive button —
  // is the part of the thread that lives in the folder on screen, never the
  // Sent copies an INBOX list merges in for context. See threadRowMembers.
  const members = useMemo(() => threadRowMembers(thread.emails), [thread.emails]);
  const allArchived = members.every(e => e.isArchived);

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
    onStartSaving(rowId);
    try {
      const rows = members.filter(em => !em.isArchived);
      if (rows.length > 0) await saveEmailsLocally(rows);
    } finally {
      onStopSaving(rowId);
    }
  };

  return (
    <div
      data-testid="email-row"
      data-thread-count={thread.messageCount}
      data-landed={landed || undefined}
      style={style}
      className={`virtual-row group relative flex items-center gap-2 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !anyChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${hasUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelectThread(thread)}
    >
      <div onClick={(e) => { e.stopPropagation(); onSetSelection(members, !anyChecked); }}>
        <input type="checkbox" checked={anyChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      <ThreadDisclosure expandable={expandable} expanded={expanded} threadId={thread.threadId} onToggleExpand={onToggleExpand} />

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        <ConnectedStateIcon email={latestEmail} size={13} />
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
          <LinkAlertIcon level={getLinkAlertLevel(thread.emails)} size={12} alerts={getAlertsForEmails(thread.emails, useMailStore.getState())} />
          <TrackerAlertIcon info={getThreadTrackerInfo(thread.emails)} blocked={trackerBlocking} size={12} />
          {/* flex-1 min-w-0: same shrink-to-nothing hazard as the row above. */}
          <span dir="auto" className={`flex-1 min-w-0 truncate text-sm leading-snug ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {displayText(thread.subject, '(No subject)')}
          </span>
          {latestEmail.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible bg-mail-surface-hover rounded-md px-1">
        {!allArchived && (
          <Button variant="ghost" icon size="xs" className="press hover:bg-mail-border" onClick={handleArchiveThread} disabled={isSaving} title={t('thread.archiveThread')}>
            {isSaving ? <RefreshCw size={13} className="animate-spin text-mail-accent-text" />
              : <Archive size={13} className="text-mail-text-muted hover:text-mail-local" />}
          </Button>
        )}
        <RowActionMenu open={menuOpen} onOpen={handleOpenMenu} onClose={onCloseMenu} size={13}>
          <RowActionMenuItems emails={members} actions={actions} onRequestDelete={onRequestDelete} onClose={onCloseMenu} />
        </RowActionMenu>
      </div>
    </div>
  );
});
