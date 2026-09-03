import { Button } from './ui/Button';
import React from 'react';
import { displayText } from '../utils/bidiText';
import { getAccountColor, useSettingsStore, isTrackerBlockingActive } from '../stores/settingsStore';
import { getSenderName } from '../utils/emailParser';
import { getCachedAlerts } from '../utils/linkSafety';
import { useMailStore } from '../stores/mailStore';
import { emailScopeKey } from '../stores/slices/unifiedHelpers';
import { useCustodyLanding } from '../hooks/useCustodyLanding';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon } from './SenderAlertIcon';
import { ReplyToAlertIcon } from './ReplyToAlertIcon';
import { TrackerAlertIcon } from './TrackerAlertIcon';
import { RowActionMenu } from './RowActionMenu';
import { RowActionMenuItems } from './RowActionMenuItems';
import { formatEmailDate } from '../utils/dateFormat';
import { ConnectedStateIcon, describeMessageState } from './email/MessageStateIcon';
import {
  RefreshCw,
  Paperclip,
  Archive,
} from 'lucide-react';
import { useT } from '../i18n/index.js';

export const EmailRow = React.memo(function EmailRow({ rowId, email, isSelected, onSelect, onToggleSelection, isChecked, style, actions, unifiedInbox, accountColors, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, isSaving, onStartSaving, onStopSaving }) {
  const t = useT();
  const handleOpenMenu = React.useCallback(() => onOpenMenu(rowId), [onOpenMenu, rowId]);
  const { saveEmailLocally } = actions;
  // Scan results are cached per `accountId-mailbox-uid`; a bare uid would pull
  // another account's links into this row's tooltip. The handoff below keys off
  // the same string, for the same reason.
  const scopeKey = emailScopeKey(email, useMailStore.getState());
  const alerts = getCachedAlerts(scopeKey);
  // Whether the glyph reads "blocked" or "tracks you" is a live setting, not a
  // property of the row's data — subscribe so a toggle repaints every row.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);

  const handleSave = async (e) => {
    e.stopPropagation();
    onStartSaving(rowId);
    try {
      await saveEmailLocally(email.uid);
    } finally {
      onStopSaving(rowId);
    }
  };

  const isUnread = !email.flags?.includes('\\Seen');
  // Custody is the glyph's job, not the row ground's: the row keeps the plain
  // surface/hover/unread background every other row has. The tone is still
  // read here so the handoff below knows when this message changed hands.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const custodyTone = describeMessageState(email, { serverKnown }).tone;
  // The handoff belongs to the row, not to the 20px chip: when a message
  // becomes yours, the row is what changed hands. Null except for the one
  // ~620ms beat after this message's own custody changed.
  const landed = useCustodyLanding(scopeKey, custodyTone);

  return (
    <div
      data-testid="email-row"
      data-uid={email.uid}
      data-landed={landed || undefined}
      style={style}
      className={`virtual-row group relative flex items-center gap-3 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !isChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${isUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelect(email.uid, email.source, email._mailbox)}
    >
      <div onClick={(e) => { e.stopPropagation(); onToggleSelection(email.uid, email._accountId, email._mailbox); }}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          className="custom-checkbox"
        />
      </div>

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        <ConnectedStateIcon email={email} size={14} />
      </div>

      <div className={`w-[32%] max-w-48 min-w-[80px] truncate flex-shrink flex items-center gap-1.5 ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {unifiedInbox && email._accountEmail && (
          <span
            data-testid="account-dot"
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
            title={email._accountEmail}
          />
        )}
        <span className="truncate" dir="auto">{displayText(getSenderName(email))}</span>
      </div>

      {/*
        min-w-[120px], not min-w-0, and flex-1 on the subject span below.
        The sender column used to be a fixed w-48 that only gave up space once
        the flex line overflowed — and min-w-0 here meant it never did, because
        this column absorbed the whole deficit instead. At a 349px row that
        left 51px for a 67px date and the subject rendered at 0px wide: for
        every message whose date carries a year, the row showed a sender and
        a date and no subject at all.

        The sender is now `w-[32%] max-w-48`, so it is a share of the row it
        actually sits in rather than of the window. Above ~600px the cap keeps
        it at the same 192px it always was; in a half-screen window or a
        dragged-narrow list pane it yields first, because a subject is what
        someone scans a list for and a sender name is what they can infer.
      */}
      <div className="flex-1 min-w-[120px] flex items-center gap-2">
        <SenderAlertIcon level={email._senderAlert} email={email} />
        <ReplyToAlertIcon mismatch={email._replyToMismatch} />
        <LinkAlertIcon level={email._linkAlert} alerts={alerts} />
        <TrackerAlertIcon info={email._trackerInfo} blocked={trackerBlocking} />
        <span dir="auto" className={`flex-1 min-w-0 truncate ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {displayText(email.subject, '(No subject)')}
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
          <Button variant="ghost" icon size="sm" className="press hover:bg-mail-border"
            onClick={handleSave}
            disabled={isSaving}
            title={t('common.archive')}
          >
            {isSaving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent-text" />
            ) : (
              <Archive size={14} className="text-mail-text-muted hover:text-mail-local" />
            )}
          </Button>
        )}

        <RowActionMenu open={menuOpen} onOpen={handleOpenMenu} onClose={onCloseMenu}>
          <RowActionMenuItems emails={[email]} actions={actions} onRequestDelete={onRequestDelete} onClose={onCloseMenu} />
        </RowActionMenu>
      </div>
    </div>
  );
});

export const CompactEmailRow = React.memo(function CompactEmailRow({ rowId, email, isSelected, onSelect, onToggleSelection, isChecked, style, actions, unifiedInbox, accountColors, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, isSaving, onStartSaving, onStopSaving }) {
  const t = useT();
  const handleOpenMenu = React.useCallback(() => onOpenMenu(rowId), [onOpenMenu, rowId]);
  const { saveEmailLocally } = actions;
  // Scan results are cached per `accountId-mailbox-uid`; a bare uid would pull
  // another account's links into this row's tooltip. The handoff below keys off
  // the same string, for the same reason.
  const scopeKey = emailScopeKey(email, useMailStore.getState());
  const alerts = getCachedAlerts(scopeKey);
  // Whether the glyph reads "blocked" or "tracks you" is a live setting, not a
  // property of the row's data — subscribe so a toggle repaints every row.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);

  const handleSave = async (e) => {
    e.stopPropagation();
    onStartSaving(rowId);
    try { await saveEmailLocally(email.uid); } finally { onStopSaving(rowId); }
  };

  const isUnread = !email.flags?.includes('\\Seen');
  // Custody is the glyph's job, not the row ground's: the row keeps the plain
  // surface/hover/unread background every other row has. The tone is still
  // read here so the handoff below knows when this message changed hands.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  const custodyTone = describeMessageState(email, { serverKnown }).tone;
  // The handoff belongs to the row, not to the 20px chip: when a message
  // becomes yours, the row is what changed hands. Null except for the one
  // ~620ms beat after this message's own custody changed.
  const landed = useCustodyLanding(scopeKey, custodyTone);

  return (
    <div
      data-testid="email-row"
      data-uid={email.uid}
      data-landed={landed || undefined}
      style={style}
      className={`virtual-row group relative flex items-center gap-2 px-4 border-b border-mail-border
                 cursor-pointer
                 ${isSelected && !isChecked ? 'border-l-2 border-l-mail-accent pl-[14px]' : 'hover:bg-mail-surface-hover'}
                 ${isUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelect(email.uid, email.source, email._mailbox)}
    >
      <div onClick={(e) => { e.stopPropagation(); onToggleSelection(email.uid, email._accountId, email._mailbox); }}>
        <input type="checkbox" checked={isChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      {/* Source icon */}
      <div className="w-5 flex items-center justify-center flex-shrink-0">
        <ConnectedStateIcon email={email} size={13} />
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
          <span dir="auto" className={`truncate text-xs ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
            {displayText(getSenderName(email))}
          </span>
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            {formatEmailDate(email.date)}
          </span>
        </div>
        {/* Line 2: Subject + attachment */}
        <div className="flex items-center gap-1.5">
          <SenderAlertIcon level={email._senderAlert} email={email} size={12} />
          <ReplyToAlertIcon mismatch={email._replyToMismatch} size={12} />
          <LinkAlertIcon level={email._linkAlert} size={12} alerts={alerts} />
          <TrackerAlertIcon info={email._trackerInfo} blocked={trackerBlocking} size={12} />
          {/* flex-1 min-w-0: same shrink-to-nothing hazard as the row above. */}
          <span dir="auto" className={`flex-1 min-w-0 truncate text-sm leading-snug ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {displayText(email.subject, '(No subject)')}
          </span>
          {email.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 invisible group-hover:visible bg-mail-surface-hover rounded-md px-1">
        {!email.isArchived && (
          <Button variant="ghost" icon size="xs" className="press hover:bg-mail-border" onClick={handleSave} disabled={isSaving} title={t('common.archive')}>
            {isSaving ? <RefreshCw size={13} className="animate-spin text-mail-accent-text" />
              : <Archive size={13} className="text-mail-text-muted hover:text-mail-local" />}
          </Button>
        )}
        <RowActionMenu open={menuOpen} onOpen={handleOpenMenu} onClose={onCloseMenu} size={13}>
          <RowActionMenuItems emails={[email]} actions={actions} onRequestDelete={onRequestDelete} onClose={onCloseMenu} />
        </RowActionMenu>
      </div>
    </div>
  );
});
