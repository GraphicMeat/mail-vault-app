import React, { useMemo } from 'react';
import { displayText } from '../utils/bidiText';
import { getRowParty, getRowPartyName, threadRowMembers } from '../utils/emailParser';
import { isOutgoingRow } from '../utils/sentFolder';
import { listRowGround } from '../utils/listRowGround';
import { getLinkAlertLevel, getAlertsForEmails } from '../utils/linkSafety';
import { useMailStore } from '../stores/mailStore';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon, getSenderAlertLevel } from './SenderAlertIcon';
import { ReplyToAlertIcon, getThreadReplyToMismatch } from './ReplyToAlertIcon';
import { TrackerAlertIcon, getThreadTrackerInfo } from './TrackerAlertIcon';
import { useSettingsStore, isTrackerBlockingActive, normalizeListPreviewLines } from '../stores/settingsStore';
import { RowQuickActions } from './RowQuickActions';
import { useMenuAtPointer } from '../hooks/useMenuAtPointer';
import { TagChips } from './TagChips';
import { formatEmailDate } from '../utils/dateFormat';
import { ConnectedStateIcon, describeMessageState } from './email/MessageStateIcon';
import { emailScopeKey } from '../stores/slices/unifiedHelpers';
import { isRowArchived } from '../utils/quickActionFacts';
import { useCustodyLanding } from '../hooks/useCustodyLanding';
import { RowGutter, RowSnippet, WithSnippet } from './EmailRow';
import {
  Paperclip,
  ChevronRight,
} from 'lucide-react';
import { t as tr, useT  } from '../i18n/index.js';
import { Private } from './privacy/Private';

// The unfold control (expandable thread mode). It sits in the row gutter's
// disclosure slot, which only an unfolding list reserves.
function ThreadDisclosure({ expanded, threadId, onToggleExpand }) {
  const t = useT();
  const label = expanded ? t('thread.hideReplies') : t('thread.showReplies');
  return (
    <button
      type="button"
      data-testid="thread-expand"
      aria-expanded={!!expanded}
      aria-label={label}
      title={label}
      className="w-5 h-5 flex items-center justify-center rounded flex-shrink-0 text-mail-text-muted hover:text-mail-text hover:bg-mail-border"
      onClick={(e) => { e.stopPropagation(); onToggleExpand(threadId); }}
    >
      <ChevronRight size={14} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </button>
  );
}

// Every distinct party in the thread, two named and the rest counted. Each
// name masks on its own, so privacy mode keeps the separators and the count.
function participantsLabel(emails, outgoing) {
  const seen = new Set();
  const names = [];
  for (const email of emails || []) {
    const addr = getRowParty(email, { outgoing })?.address?.toLowerCase() || '';
    if (!seen.has(addr)) {
      seen.add(addr);
      names.push(getRowPartyName(email, { outgoing }));
    }
  }
  const shown = names.slice(0, 2).map((name, i) => (
    <React.Fragment key={i}>{i ? ', ' : ''}<Private kind="name">{name}</Private></React.Fragment>
  ));
  return names.length <= 2 ? shown : <>{shown} +{names.length - 2}</>;
}

// Thread row for default layout — shows collapsed thread with participant names and count
export const ThreadRow = React.memo(function ThreadRow({ rowId, thread, isSelected, onSelectThread, onSetSelection, anyChecked, style, actions, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, onActionStart, isSaving, onStartSaving, onStopSaving, expandable, expanded, onToggleExpand }) {
  const t = useT();
  // Preview lines make this a row of several lines: its gutter stacks.
  const stacked = useSettingsStore(s => normalizeListPreviewLines(s.listPreviewLines)) > 0;
  const dense = useSettingsStore(s => s.listDensity) === 'compact';

  // Hooks stay above the early return: a row that loses its lastEmail must not
  // shift the hook order underneath it. A thread's custody is its newest
  // message's custody, so that is what hands over.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const scopeKey = emailScopeKey(thread?.lastEmail, useMailStore.getState());
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  // Which mode marks the row is a live setting too — a toggle repaints the list.
  const highlight = useSettingsStore(s => s.emailRowHighlight);
  const holdsOpen = isSelected && !anyChecked;
  // An unfolded thread row is the container, not the message being read — its
  // members carry the mark. Folded, it IS the row you opened. Only the marking
  // mode has a sibling ground to demote to, so hover mode is untouched.
  const demoted = highlight === 'selection' && expandable && expanded;
  // Server view writes isArchived false on every row it lists, so the row's
  // own flag never moves there; the keyed archived set does (isRowArchived).
  const vaultHeld = useMailStore(s => !!thread?.lastEmail && !thread.lastEmail.isArchived && isRowArchived(thread.lastEmail, s));
  const custodyTone = thread?.lastEmail
    ? describeMessageState(vaultHeld ? { ...thread.lastEmail, isArchived: true } : thread.lastEmail, { serverKnown }).tone
    : null;
  const landed = useCustodyLanding(scopeKey, custodyTone);
  // A thread in an outgoing folder names who it went TO, not you, on every row.
  const outgoing = isOutgoingRow(thread?.lastEmail, useMailStore.getState());
  // Everything this row acts on — its checkbox, its menu, its archive button —
  // is the part of the thread that lives in the folder on screen, never the
  // Sent copies an INBOX list merges in for context. See threadRowMembers.
  const members = useMemo(() => threadRowMembers(thread?.emails), [thread?.emails]);
  const [menuAt, pointerMenuHandlers, live] = useMenuAtPointer();
  // Quick actions mount on the live row only; an open menu holds it live.
  const holdMenu = busy => (busy ? onOpenMenu?.(rowId) : onCloseMenu?.(rowId));

  // Build participant display: every distinct sender in the thread, the user
  // included — a conversation you replied to shows your name too. In an
  // outgoing folder that list is you, repeated, so it names the recipients.
  const participantNames = useMemo(() => participantsLabel(thread?.emails, outgoing), [thread?.emails, outgoing]);

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;

  const handleArchiveThread = async (e) => {
    e.stopPropagation();
    onStartSaving(rowId);
    try {
      const rows = members.filter(em => !isRowArchived(em, useMailStore.getState()));
      if (rows.length > 0) await actions.saveEmailsLocally(rows);
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
      className={`virtual-row group relative flex ${stacked ? 'row-top' : 'items-center'}${dense ? ' row-dense' : ''} gap-3 px-4 border-b border-mail-border
                 cursor-pointer
                 ${listRowGround({ highlight, selected: holdsOpen && !demoted, related: holdsOpen && demoted, unread: hasUnread })}`}
      onClick={() => onSelectThread(thread)}
      {...pointerMenuHandlers}
    >
      <RowGutter stacked={stacked} threadSlot={expandable} checked={anyChecked}
        onToggle={(e) => onSetSelection(members, !anyChecked, e?.shiftKey)}
        disclosure={<ThreadDisclosure expanded={expanded} threadId={thread.threadId} onToggleExpand={onToggleExpand} />}
        state={<ConnectedStateIcon email={latestEmail} size={14} />} />

      <WithSnippet email={latestEmail}>
      {/*
        No `truncate` on the column itself — that clips the alert icons that
        now sit after the names. The names span truncates instead.
      */}
      <div className={`w-[32%] max-w-48 min-w-[80px] flex-shrink flex items-center gap-1.5 ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
        <span data-testid="row-sender" className="truncate min-w-0">{participantNames}</span>
        {(() => { const sa = getSenderAlertLevel(thread.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} /> : null; })()}
        <ReplyToAlertIcon mismatch={getThreadReplyToMismatch(thread.emails)} />
        <LinkAlertIcon level={getLinkAlertLevel(thread.emails)} alerts={getAlertsForEmails(thread.emails, useMailStore.getState())} />
        <TrackerAlertIcon info={getThreadTrackerInfo(thread.emails)} blocked={trackerBlocking} />
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
        <span data-testid="row-subject" dir="auto" className={`flex-1 min-w-0 truncate ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          <Private kind="text">{displayText(thread.subject, '(No subject)')}</Private>
        </span>
        <TagChips email={members} />
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
      </WithSnippet>

      {(live || menuOpen) && <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible group-focus-within:visible bg-mail-surface-hover rounded-md px-1">
        <RowQuickActions emails={members} exportEmails={thread.emails} actions={actions} onRequestDelete={onRequestDelete} onActionStart={onActionStart}
          onClose={onCloseMenu} onArchive={handleArchiveThread} disabled={isSaving} identity={scopeKey} openAt={menuAt} onBusyChange={holdMenu} />
      </div>}
    </div>
  );
});

// Compact thread row for compact layout
export const CompactThreadRow = React.memo(function CompactThreadRow({ rowId, thread, isSelected, onSelectThread, onSetSelection, anyChecked, style, actions, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, onActionStart, isSaving, onStartSaving, onStopSaving, expandable, expanded, onToggleExpand }) {
  const t = useT();
  const dense = useSettingsStore(s => s.listDensity) === 'compact';

  // Hooks stay above the early return: a row that loses its lastEmail must not
  // shift the hook order underneath it. A thread's custody is its newest
  // message's custody, so that is what hands over.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const scopeKey = emailScopeKey(thread?.lastEmail, useMailStore.getState());
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  // Which mode marks the row is a live setting too — a toggle repaints the list.
  const highlight = useSettingsStore(s => s.emailRowHighlight);
  const holdsOpen = isSelected && !anyChecked;
  // An unfolded thread row is the container, not the message being read — its
  // members carry the mark. Folded, it IS the row you opened. Only the marking
  // mode has a sibling ground to demote to, so hover mode is untouched.
  const demoted = highlight === 'selection' && expandable && expanded;
  // Server view writes isArchived false on every row it lists, so the row's
  // own flag never moves there; the keyed archived set does (isRowArchived).
  const vaultHeld = useMailStore(s => !!thread?.lastEmail && !thread.lastEmail.isArchived && isRowArchived(thread.lastEmail, s));
  const custodyTone = thread?.lastEmail
    ? describeMessageState(vaultHeld ? { ...thread.lastEmail, isArchived: true } : thread.lastEmail, { serverKnown }).tone
    : null;
  const landed = useCustodyLanding(scopeKey, custodyTone);
  // A thread in an outgoing folder names who it went TO, not you, on every row.
  const outgoing = isOutgoingRow(thread?.lastEmail, useMailStore.getState());
  // Everything this row acts on — its checkbox, its menu, its archive button —
  // is the part of the thread that lives in the folder on screen, never the
  // Sent copies an INBOX list merges in for context. See threadRowMembers.
  const members = useMemo(() => threadRowMembers(thread?.emails), [thread?.emails]);
  const [menuAt, pointerMenuHandlers, live] = useMenuAtPointer();
  // Quick actions mount on the live row only; an open menu holds it live.
  const holdMenu = busy => (busy ? onOpenMenu?.(rowId) : onCloseMenu?.(rowId));
  const participantNames = useMemo(() => participantsLabel(thread?.emails, outgoing), [thread?.emails, outgoing]);

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;

  const handleArchiveThread = async (e) => {
    e.stopPropagation();
    onStartSaving(rowId);
    try {
      const rows = members.filter(em => !isRowArchived(em, useMailStore.getState()));
      if (rows.length > 0) await actions.saveEmailsLocally(rows);
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
      className={`virtual-row row-compact row-top${dense ? ' row-dense' : ''} group relative flex gap-2 px-4 border-b border-mail-border
                 cursor-pointer
                 ${listRowGround({ highlight, selected: holdsOpen && !demoted, related: holdsOpen && demoted, unread: hasUnread })}`}
      onClick={() => onSelectThread(thread)}
      {...pointerMenuHandlers}
    >
      {/* Two lines, always: the chip sits under the checkbox. */}
      <RowGutter stacked threadSlot={expandable} checked={anyChecked}
        onToggle={(e) => onSetSelection(members, !anyChecked, e?.shiftKey)}
        disclosure={<ThreadDisclosure expanded={expanded} threadId={thread.threadId} onToggleExpand={onToggleExpand} />}
        state={<ConnectedStateIcon email={latestEmail} size={13} />} />

      <div className={`flex-1 min-w-0 ${dense ? 'py-0.5' : 'py-1.5'}`}>
        {/* Line 1: participants, count, alerts ... date */}
        <div className="flex items-center gap-1.5">
          <span data-testid="row-sender" className={`truncate min-w-0 text-xs ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {participantNames}
          </span>
          {thread.messageCount > 1 && (
            <span className="flex-shrink-0 min-w-[16px] h-4 px-1 bg-mail-text-muted/15 rounded-full
                          text-mail-text-muted text-[10px] font-medium flex items-center justify-center">
              {thread.messageCount}
            </span>
          )}
          {(() => { const sa = getSenderAlertLevel(thread.emails); return sa ? <SenderAlertIcon level={sa.level} email={sa.email} size={12} /> : null; })()}
          <ReplyToAlertIcon mismatch={getThreadReplyToMismatch(thread.emails)} size={12} />
          <LinkAlertIcon level={getLinkAlertLevel(thread.emails)} size={12} alerts={getAlertsForEmails(thread.emails, useMailStore.getState())} />
          <TrackerAlertIcon info={getThreadTrackerInfo(thread.emails)} blocked={trackerBlocking} size={12} />
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            {formatEmailDate(latestEmail.date)}
          </span>
        </div>
        {/* Line 2: Subject + attachment. Nothing before the subject, so its
            left edge is the participants' on every row. */}
        <div className="flex items-center gap-1.5">
          {/* flex-1 min-w-0: same shrink-to-nothing hazard as the row above. */}
          <span data-testid="row-subject" dir="auto" className={`flex-1 min-w-0 truncate text-sm leading-snug ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            <Private kind="text">{displayText(thread.subject, '(No subject)')}</Private>
          </span>
          <TagChips email={members} />
          {latestEmail.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
        <RowSnippet email={latestEmail} />
      </div>

      {/* Hover actions */}
      {(live || menuOpen) && <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible group-focus-within:visible bg-mail-surface-hover rounded-md px-1">
        <RowQuickActions emails={members} exportEmails={thread.emails} actions={actions} onRequestDelete={onRequestDelete} onActionStart={onActionStart}
          onClose={onCloseMenu} onArchive={handleArchiveThread} disabled={isSaving} identity={scopeKey} display="icon-only" openAt={menuAt} onBusyChange={holdMenu} />
      </div>}
    </div>
  );
});
