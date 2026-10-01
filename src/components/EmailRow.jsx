import React from 'react';
import { displayText } from '../utils/bidiText';
import { cleanPreviewText } from '../utils/previewText';
import { BimiLogo } from './email/BimiLogo';
import { getAccountColor, useSettingsStore, isTrackerBlockingActive, normalizeListPreviewLines } from '../stores/settingsStore';
import { getRowPartyName } from '../utils/emailParser';
import { isOutgoingRow } from '../utils/sentFolder';
import { listRowGround } from '../utils/listRowGround';
import { getCachedAlerts } from '../utils/linkSafety';
import { useMailStore } from '../stores/mailStore';
import { emailScopeKey, selectionKey, spansMailboxes, rowKey } from '../stores/slices/unifiedHelpers';
import { useCustodyLanding } from '../hooks/useCustodyLanding';
import { LinkAlertIcon } from './LinkAlertIcon';
import { SenderAlertIcon } from './SenderAlertIcon';
import { ReplyToAlertIcon } from './ReplyToAlertIcon';
import { TrackerAlertIcon } from './TrackerAlertIcon';
import { RowQuickActions } from './RowQuickActions';
import { useMenuAtPointer } from '../hooks/useMenuAtPointer';
import { TagChips } from './TagChips';
import { formatEmailDate, intlLocale, hour12For } from '../utils/dateFormat';
import { useSnoozeStore, wakeAtFor } from '../stores/snoozeStore';
import { ConnectedStateIcon, describeMessageState } from './email/MessageStateIcon';
import { isRowArchived } from '../utils/quickActionFacts';
import {
  AlarmClock,
  Paperclip,
  Star,
} from 'lucide-react';
import { useT } from '../i18n/index.js';
import { Private } from './privacy/Private';
import { usePrivateAttr } from '../hooks/usePrivacy';

// A search hit whose term lives only in an attachment shows nothing in the
// message itself. `matchedIn` comes back from the offline index; the row's own
// paperclip is where it is cheapest to say so.
function AttachmentGlyph({ email, size }) {
  const t = useT();
  if (!email.hasAttachments) return null;
  const inAttachment = email.matchedIn?.includes('attachment');
  return inAttachment ? (
    <Paperclip data-testid="attachment-match" size={size} title={t('search.matchInAttachment')}
      className="text-mail-accent-text flex-shrink-0" />
  ) : (
    <Paperclip size={size} className="text-mail-text-muted flex-shrink-0" />
  );
}

/**
 * The star, in both row variants.
 *
 * Hidden until the row is hovered unless it is lit: an empty star on every row
 * of a long list is noise, a lit one is the information the list is for.
 *
 * The click carries the row's SELECTION key, not its uid — a merged Sent copy
 * and the folder's own message share a number, and only one of them was
 * clicked.
 *
 * It sits on the sender line in every row variant, never beside the date: the
 * row's hover actions are an absolute overlay pinned to the right edge, so a
 * star that only appears on hover would appear underneath them.
 *
 * Nothing sits ahead of the subject, the star included: a thread row has no
 * star, so a message row whose subject started one star-width further right
 * than its thread-row neighbour's put a zig-zag down the subject column — the
 * same defect the alert icons made, just constant per row kind.
 */
function StarToggle({ email, actions, size }) {
  const t = useT();
  const isFlagged = email.flags?.includes('\\Flagged');
  // Keep the sender/status cluster stable when another glyph is present. An
  // empty star may stay quiet on a plain row, but appearing beside tracker,
  // warning, or attachment icons only on hover shifts the cluster visually.
  const hasStatusIcon = Boolean(email.has_attachments || email.hasAttachments
    || email._senderAlert || email._replyToMismatch || email._linkAlert || email._trackerInfo?.count);
  const label = isFlagged ? t('rowMenu.unstar') : t('rowMenu.star');
  return (
    <button
      type="button"
      data-testid="star-toggle"
      aria-pressed={!!isFlagged}
      aria-label={label}
      title={label}
      className={`shrink-0 p-0.5 rounded press ${isFlagged || hasStatusIcon ? '' : 'invisible group-hover:visible group-focus-within:visible'}`}
      onClick={(e) => { e.stopPropagation(); actions.toggleFlagged?.(selectionKey(email, useMailStore.getState())); }}
    >
      <Star size={size} className={isFlagged ? 'text-amber-400 fill-amber-400' : 'text-mail-text-muted hover:text-amber-400'} />
    </button>
  );
}

// The list's preview line (Settings > Workspace > Preview lines): a fixed
// line height, so a row is its layout's height plus N of these, the same for
// every row whatever its text and the virtualizer never has to measure one.
export const SNIPPET_LINE_PX = 16;
const ROW_BASE_PX = { compact: 52, default: 56 };
// Message list density compact (Settings > Appearance > Layout): the same
// lines with less air around them, `.row-dense` in index.css.
const DENSE_ROW_BASE_PX = { compact: 44, default: 40 };

export function listRowHeight(compact, previewLines = 0, density = 'comfortable') {
  const base = density === 'compact' ? DENSE_ROW_BASE_PX : ROW_BASE_PX;
  return (compact ? base.compact : base.default) + previewLines * SNIPPET_LINE_PX;
}

/**
 * The start of the message's text under the row, clamped to the lines the
 * user asked for: `previewText`, which the daemon attaches from the offline
 * search index, or a vault row's own `snippet`. A row whose body nobody has
 * read shows nothing here: no placeholder.
 */
export function RowSnippet({ email }) {
  const lines = useSettingsStore(s => normalizeListPreviewLines(s.listPreviewLines));
  const text = cleanPreviewText(email?.previewText || email?.snippet);
  if (!lines || !text) return null;
  return (
    <div data-testid="row-snippet" dir="auto" className="row-snippet" style={{ WebkitLineClamp: lines, maxHeight: lines * SNIPPET_LINE_PX }}>
      <Private kind="text">{text}</Private>
    </div>
  );
}

/**
 * A single-line row's sender and subject columns, with the preview line under
 * them. With the setting off this adds no element at all, so the row keeps
 * exactly the layout it had before preview lines existed. With it on, every
 * row is wrapped, preview or not: the sender column is a share of its
 * container, and a subject must start at the same x on every row.
 */
export function WithSnippet({ email, children }) {
  const lines = useSettingsStore(s => normalizeListPreviewLines(s.listPreviewLines));
  if (!lines) return children;
  return (
    <div className="flex-1 min-w-0 flex flex-col justify-center">
      <div className="flex items-center gap-3">{children}</div>
      <RowSnippet email={email} />
    </div>
  );
}

/**
 * The row's leading column: the checkbox, the custody chip and, in a list that
 * unfolds threads, the disclosure. Its width is the list's, never the row's:
 * the chip keeps its 20px slot when it draws nothing, and every row of an
 * unfolding list keeps the disclosure's slot, chevron or not. Anything with a
 * per-row width here would start the text at a different x on every row.
 *
 * `stacked` is a row of two or more lines (the two-line layout, or preview
 * lines on): the chip moves under the checkbox, so the gutter is one icon
 * wide and the text gets the room back.
 */
export function RowGutter({ stacked, threadSlot, disclosure = null, checked, onToggle, state }) {
  const t = useT();
  return (
    <div data-testid="row-gutter" className={`row-gutter${stacked ? ' row-gutter-stacked' : ''}`}>
      {threadSlot && <div data-testid="row-disclosure-slot" className="row-gutter-slot">{disclosure}</div>}
      <div className="row-gutter-cell">
        {/* Shift held: the click ticks a range (onToggle reads e.shiftKey), and
            mousedown must not also drag a text selection across the rows. */}
        <div className="row-gutter-check" onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
          onClick={(e) => { e.stopPropagation(); onToggle(e); }}>
          <input type="checkbox" checked={checked} onChange={() => {}} aria-label={t('workspace.selectMessage')} className="custom-checkbox" />
        </div>
        <div data-testid="row-state-slot" className="row-gutter-slot">{state}</div>
      </div>
    </div>
  );
}

// A snoozed message (it sits in Snoozed) shows when it comes back instead of
// when it arrived.
function RowDate({ email }) {
  const t = useT();
  const timeFormat = useSettingsStore(s => s.timeFormat);
  const wakeAt = useSnoozeStore(s => wakeAtFor(s.rows, email._accountId || useMailStore.getState().activeAccountId, email.messageId));
  if (wakeAt == null) return formatEmailDate(email.date);
  const when = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: hour12For(timeFormat) }).format(wakeAt);
  return (
    <span data-testid="row-snoozed-until" title={t('snooze.until', { time: when })} className="inline-flex items-center gap-1">
      <AlarmClock size={11} aria-hidden="true" />{when}
    </span>
  );
}

// In a spanning view a bare uid names no message, so the click carries the
// row's full key. A single-folder list keeps the uid: selectEmail reads its
// first argument as a bare uid there.
function openRow(email, onSelect) {
  onSelect(rowKey(email, spansMailboxes(useMailStore.getState())), email.source, email._mailbox);
}

// `pinActions` shows the quick actions without a hover; `preview` and
// `configOverride` pass through to them (Settings' sample rows).
export const EmailRow = React.memo(function EmailRow({ rowId, email, isSelected, isRelated = false, onSelect, onToggleSelection, isChecked, style, actions, unifiedInbox, accountColors, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, onActionStart, isSaving, onStartSaving, onStopSaving, threadSlot = false, pinActions = false, preview = false, configOverride }) {
  const t = useT();
  const pa = usePrivateAttr();
  // Preview lines make this a row of several lines: its gutter stacks.
  const stacked = useSettingsStore(s => normalizeListPreviewLines(s.listPreviewLines)) > 0;
  const dense = useSettingsStore(s => s.listDensity) === 'compact';
  // Scan results are cached per `accountId-mailbox-uid`; a bare uid would pull
  // another account's links into this row's tooltip. The handoff below keys off
  // the same string, for the same reason.
  const scopeKey = emailScopeKey(email, useMailStore.getState());
  const [menuAt, pointerMenuHandlers, live] = useMenuAtPointer();
  // Quick actions mount on the live row only; an open menu holds it live.
  const holdMenu = busy => (busy ? onOpenMenu?.(rowId) : onCloseMenu?.(rowId));
  const alerts = getCachedAlerts(scopeKey);
  // Whether the glyph reads "blocked" or "tracks you" is a live setting, not a
  // property of the row's data — subscribe so a toggle repaints every row.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  // Which mode marks the row is a live setting too — a toggle repaints the list.
  const highlight = useSettingsStore(s => s.emailRowHighlight);

  const handleSave = async (e) => {
    e.stopPropagation();
    onStartSaving(rowId);
    try {
      await actions.saveEmailsLocally([email]);
    } finally {
      onStopSaving(rowId);
    }
  };

  // A row in an outgoing folder names who the message went TO — in Sent the
  // sender is you on every row, which is the one thing you already know.
  const outgoing = isOutgoingRow(email, useMailStore.getState());

  const isUnread = !email.flags?.includes('\\Seen');
  // Custody is the glyph's job, not the row ground's: the row keeps the plain
  // surface/hover/unread background every other row has. The tone is still
  // read here so the handoff below knows when this message changed hands.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  // Server view writes isArchived false on every row it lists, so the row's
  // own flag never moves there; the keyed archived set does (isRowArchived).
  const vaultHeld = useMailStore(s => !email.isArchived && isRowArchived(email, s));
  const custodyTone = describeMessageState(vaultHeld ? { ...email, isArchived: true } : email, { serverKnown }).tone;
  // The handoff belongs to the row, not to the 20px chip: when a message
  // becomes yours, the row is what changed hands. Null except for the one
  // ~620ms beat after this message's own custody changed.
  const landed = useCustodyLanding(scopeKey, custodyTone);

  return (
    <div
      data-testid="email-row"
      data-uid={email.uid}
      data-landed={landed || undefined}
      data-quick-actions-preview={preview || undefined}
      style={style}
      className={`virtual-row group relative flex ${stacked ? 'row-top' : 'items-center'}${dense ? ' row-dense' : ''} gap-3 px-4 border-b border-mail-border
                 cursor-pointer
                 ${listRowGround({ highlight, selected: isSelected && !isChecked, related: isRelated && !isChecked, unread: isUnread })}`}
      onClick={() => openRow(email, onSelect)}
      {...pointerMenuHandlers}
    >
      <RowGutter stacked={stacked} threadSlot={threadSlot} checked={isChecked}
        onToggle={(e) => onToggleSelection(email.uid, email._accountId, email._mailbox, e?.shiftKey)}
        state={<ConnectedStateIcon email={email} size={14} />} />

      <WithSnippet email={email}>
      {/*
        No `truncate` on the column itself — that clips the alert icons that
        now sit after the name. The name span truncates instead, which is what
        was meant all along.
      */}
      <div className={`w-[32%] max-w-48 min-w-[80px] flex-shrink flex items-center gap-1.5 ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
        {unifiedInbox && email._accountEmail && (
          <span
            data-testid="account-dot"
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
            title={pa(email._accountEmail, 'email')}
          />
        )}
        <span data-testid="row-sender" className="truncate min-w-0" dir="auto">
          {outgoing && `${t('email.original.to')} `}<Private kind="name">{displayText(getRowPartyName(email, { outgoing }))}</Private>
        </span>
        <BimiLogo email={email} size={14} />
        <StarToggle email={email} actions={actions} size={14} />
        <SenderAlertIcon level={email._senderAlert} email={email} />
        <ReplyToAlertIcon mismatch={email._replyToMismatch} />
        <LinkAlertIcon level={email._linkAlert} alerts={alerts} />
        <TrackerAlertIcon info={email._trackerInfo} blocked={trackerBlocking} />
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
        <span data-testid="row-subject" dir="auto" className={`flex-1 min-w-0 truncate ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          <Private kind="text">{displayText(email.subject, '(No subject)')}</Private>
        </span>
        <TagChips email={email} />
        <AttachmentGlyph email={email} size={14} />
        <span className="ml-auto text-xs text-mail-text-muted whitespace-nowrap flex-shrink-0">
          <RowDate email={email} />
        </span>
      </div>
      </WithSnippet>

      {(live || menuOpen || pinActions) && <div className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 ${pinActions ? '' : 'invisible group-hover:visible group-focus-within:visible'} bg-mail-surface-hover rounded-md px-1`}>
        <RowQuickActions emails={[email]} actions={actions} onRequestDelete={onRequestDelete} onClose={onCloseMenu} onActionStart={onActionStart}
          onArchive={handleSave} disabled={isSaving} identity={scopeKey} openAt={menuAt} onBusyChange={holdMenu}
          preview={preview} configOverride={configOverride} />
      </div>}
    </div>
  );
});

export const CompactEmailRow = React.memo(function CompactEmailRow({ rowId, email, isSelected, isRelated = false, onSelect, onToggleSelection, isChecked, style, actions, unifiedInbox, accountColors, menuOpen, onOpenMenu, onCloseMenu, onRequestDelete, onActionStart, isSaving, onStartSaving, onStopSaving, threadSlot = false, pinActions = false, preview = false, configOverride }) {
  const t = useT();
  const pa = usePrivateAttr();
  const dense = useSettingsStore(s => s.listDensity) === 'compact';
  // Scan results are cached per `accountId-mailbox-uid`; a bare uid would pull
  // another account's links into this row's tooltip. The handoff below keys off
  // the same string, for the same reason.
  const scopeKey = emailScopeKey(email, useMailStore.getState());
  const [menuAt, pointerMenuHandlers, live] = useMenuAtPointer();
  // Quick actions mount on the live row only; an open menu holds it live.
  const holdMenu = busy => (busy ? onOpenMenu?.(rowId) : onCloseMenu?.(rowId));
  const alerts = getCachedAlerts(scopeKey);
  // Whether the glyph reads "blocked" or "tracks you" is a live setting, not a
  // property of the row's data — subscribe so a toggle repaints every row.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  // Which mode marks the row is a live setting too — a toggle repaints the list.
  const highlight = useSettingsStore(s => s.emailRowHighlight);

  const handleSave = async (e) => {
    e.stopPropagation();
    onStartSaving(rowId);
    try { await actions.saveEmailsLocally([email]); } finally { onStopSaving(rowId); }
  };

  // A row in an outgoing folder names who the message went TO — in Sent the
  // sender is you on every row, which is the one thing you already know.
  const outgoing = isOutgoingRow(email, useMailStore.getState());

  const isUnread = !email.flags?.includes('\\Seen');
  // Custody is the glyph's job, not the row ground's: the row keeps the plain
  // surface/hover/unread background every other row has. The tone is still
  // read here so the handoff below knows when this message changed hands.
  const serverKnown = useMailStore(s => s.serverUids.complete);
  // Server view writes isArchived false on every row it lists, so the row's
  // own flag never moves there; the keyed archived set does (isRowArchived).
  const vaultHeld = useMailStore(s => !email.isArchived && isRowArchived(email, s));
  const custodyTone = describeMessageState(vaultHeld ? { ...email, isArchived: true } : email, { serverKnown }).tone;
  // The handoff belongs to the row, not to the 20px chip: when a message
  // becomes yours, the row is what changed hands. Null except for the one
  // ~620ms beat after this message's own custody changed.
  const landed = useCustodyLanding(scopeKey, custodyTone);

  return (
    <div
      data-testid="email-row"
      data-uid={email.uid}
      data-landed={landed || undefined}
      data-quick-actions-preview={preview || undefined}
      style={style}
      className={`virtual-row row-compact row-top${dense ? ' row-dense' : ''} group relative flex gap-2 px-4 border-b border-mail-border
                 cursor-pointer
                 ${listRowGround({ highlight, selected: isSelected && !isChecked, related: isRelated && !isChecked, unread: isUnread })}`}
      onClick={() => openRow(email, onSelect)}
      {...pointerMenuHandlers}
    >
      {/* Two lines, always: the chip sits under the checkbox. */}
      <RowGutter stacked threadSlot={threadSlot} checked={isChecked}
        onToggle={(e) => onToggleSelection(email.uid, email._accountId, email._mailbox, e?.shiftKey)}
        state={<ConnectedStateIcon email={email} size={13} />} />

      {/* Two-line content */}
      <div className={`flex-1 min-w-0 ${dense ? 'py-0.5' : 'py-1.5'}`}>
        {/* Line 1: Sender, star, alerts ... Date */}
        <div className="flex items-center gap-1.5">
          {unifiedInbox && email._accountEmail && (
            <span
              data-testid="account-dot"
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
              title={pa(email._accountEmail, 'email')}
            />
          )}
          <span data-testid="row-sender" dir="auto" className={`truncate min-w-0 text-xs ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {outgoing && `${t('email.original.to')} `}<Private kind="name">{displayText(getRowPartyName(email, { outgoing }))}</Private>
          </span>
          <BimiLogo email={email} size={13} />
          <StarToggle email={email} actions={actions} size={13} />
          <SenderAlertIcon level={email._senderAlert} email={email} size={12} />
          <ReplyToAlertIcon mismatch={email._replyToMismatch} size={12} />
          <LinkAlertIcon level={email._linkAlert} size={12} alerts={alerts} />
          <TrackerAlertIcon info={email._trackerInfo} blocked={trackerBlocking} size={12} />
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            <RowDate email={email} />
          </span>
        </div>
        {/* Line 2: Subject + attachment. Nothing before the subject, so its
            left edge is the sender's on every row. */}
        <div className="flex items-center gap-1.5">
          {/* flex-1 min-w-0: same shrink-to-nothing hazard as the row above. */}
          <span data-testid="row-subject" dir="auto" className={`flex-1 min-w-0 truncate text-sm leading-snug ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            <Private kind="text">{displayText(email.subject, '(No subject)')}</Private>
          </span>
          <TagChips email={email} />
          <AttachmentGlyph email={email} size={12} />
        </div>
        <RowSnippet email={email} />
      </div>

      {/* Hover actions */}
      {(live || menuOpen || pinActions) && <div className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 ${pinActions ? '' : 'invisible group-hover:visible group-focus-within:visible'} bg-mail-surface-hover rounded-md px-1`}>
        <RowQuickActions emails={[email]} actions={actions} onRequestDelete={onRequestDelete} onClose={onCloseMenu} onActionStart={onActionStart}
          onArchive={handleSave} disabled={isSaving} identity={scopeKey} display="icon-only" openAt={menuAt} onBusyChange={holdMenu}
          preview={preview} configOverride={configOverride} />
      </div>}
    </div>
  );
});
