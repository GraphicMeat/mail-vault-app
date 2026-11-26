// One list row. Fixed height (ROW_HEIGHT) so the virtualizer positions rows from the estimate
// alone and never measures. Text goes through the same display helpers the desktop row uses.
// The row swipes (SwipeRow.jsx). What each side does is a preference: swiping right reveals the
// leading side (`swipeRightAction`, toggle read by default), swiping left the trailing side
// (`swipeLeftAction`, delete by default); `none` leaves that side still. `onSwipe(kind, row)` gets
// `seen`, `unseen`, `flag`, `unflag`, `delete` or `move`.
// A conversation's row (`threadCount` over 1, engine `threads.rs`) is its newest message's, with
// the number of messages beside the sender; it reads unread while any message is, and a swipe on
// it acts on every message (App.jsx, prefs.js `rowUids`).
// The row's look follows the preferences: `listPreviewLines` lines of the message's text under
// the subject (none at 0), `listDensity`'s padding, and its height (prefs.js `rowHeight`, which
// also scales with the text size). With `trackpadSwipeEnabled` off (desktop's swipe switch) the
// row does not swipe.
// The message's tags follow the subject on its line, as on desktop's row (TagChips.jsx).
// Flagged and attachment indicators are desktop's glyphs at 14px before the date (a filled star in
// the flag colour, a muted paperclip when the engine's row says `hasAttachments`), fixed boxes, so
// neither changes the row's height. A conversation's paperclip is its newest message's.
// Deliberately not built on src/components/EmailRow: that pulls in the desktop stores.
// `RowFace` is what the row shows; Settings > Appearance > Layout draws its sample with it.
import React, { forwardRef, memo } from 'react';
import { displayText } from '../utils/bidiText.js';
import { cleanPreviewText } from '../utils/previewText.js';
import { formatEmailDate } from './format.js';
import { t as translate, useT } from './i18n.js';
import SwipeRow from './SwipeRow.jsx';
import { accountColor } from './accountColor.js';
import { initialOf } from './AccountSwitcher.jsx';
import { EnvelopeIcon, TrashIcon, FlagIcon, MoveIcon, PaperclipIcon } from './icons.jsx';
import { useMobileStore } from './store.js';
import { swipeKind, rowHeight, PREF_DEFAULTS } from './prefs.js';
import { accountRowKey } from './messagePages.js';
import TagChips from './TagChips.jsx';

/** Row height in px at the default preferences: three lines of text plus padding; well over the
 *  44px tap minimum. The row's own height is `rowHeight(prefs)`. */
export const ROW_HEIGHT = rowHeight(PREF_DEFAULTS);

function senderOf(row, t = translate) {
  return displayText(row.fromName, '') || displayText(row.fromAddress, '') || t('explorer.unknownSender');
}

/**
 * What a row shows, at `prefs`' density and preview lines: sender, conversation count, flag, paperclip, date,
 * subject (then `tags`), the message's text. `shown`: the row as it reads (a conversation's unread
 * and flag); `as`: the element (a button in the list, a plain box in a sample). The rest of the
 * props and the ref go to that element (SwipeRow drives the list's row through them).
 */
export const RowFace = forwardRef(function RowFace({ row, shown = row, prefs, account = null, tags = null, as: Face = 'button', ...rest }, ref) {
  const t = useT();
  const previewLines = [0, 1, 2, 3].includes(prefs.listPreviewLines) ? prefs.listPreviewLines : 1;
  return (
    <Face
      {...rest}
      ref={ref}
      type={Face === 'button' ? 'button' : undefined}
      className={`mv-row${!shown.seen ? ' mv-row--unread' : ''}${prefs.listDensity === 'compact' ? ' mv-row--compact' : ''}`}
    >
      <span className="mv-row__top">
        {account && (
          <span className="mv-row__acct" role="img" aria-label={account.email} style={{ backgroundColor: accountColor(account) }}>{initialOf(account)}</span>
        )}
        <span className="mv-row__sender" dir="auto">{senderOf(row, t)}</span>
        {row.threadCount > 1 && (
          <span className="mv-row__count" data-mv-thread-count={row.threadCount} role="img" aria-label={t('email.thread.messagesInThread', { count: row.threadCount })}>
            {row.threadCount}
          </span>
        )}
        {shown.flagged && (
          <span className="mv-row__flag" role="img" aria-label={t('mobile.actions.flagged')}><FlagIcon filled size={14} /></span>
        )}
        {row.hasAttachments && (
          <span className="mv-row__attach" role="img" aria-label={t('chat.topics.hasAttachments')}><PaperclipIcon size={14} /></span>
        )}
        <span className="mv-row__date">{formatEmailDate(row.dateMs, undefined, prefs)}</span>
      </span>
      <span className="mv-row__line">
        <span className="mv-row__subject" dir="auto">{displayText(row.subject, t('common.noSubject'))}</span>
        {tags}
      </span>
      {previewLines > 0 && (
        <span
          className={previewLines > 1 ? 'mv-row__snippet mv-row__snippet--lines' : 'mv-row__snippet'}
          data-mv-preview-lines={previewLines}
          style={previewLines > 1 ? { WebkitLineClamp: previewLines } : undefined}
          dir="auto"
        >
          {cleanPreviewText(row.snippet)}
        </span>
      )}
    </Face>
  );
});

/** `account`: set in All Inboxes, where the row starts with desktop's account badge: the account's initial on its colour. */
function MessageRow({ row, index, start = 0, onOpen, onSwipe, initialSwipe = null, account = null }) {
  const t = useT();
  const swipes = useMobileStore((s) => s.prefs.trackpadSwipeEnabled !== false);
  const leadingAction = useMobileStore((s) => (swipes ? s.prefs.swipeRightAction : 'none'));
  const trailingAction = useMobileStore((s) => (swipes ? s.prefs.swipeLeftAction : 'none'));
  const prefs = useMobileStore((s) => s.prefs);
  // A folder's rows name neither; All Inboxes' and search's name both.
  const accountId = useMobileStore((s) => s.activeAccountId);
  const folder = useMobileStore((s) => s.activeFolder);
  const style = { height: `${rowHeight(prefs)}px`, transform: `translateY(${start}px)` };
  if (!row) {
    return <div className="mv-row-slot mv-row--placeholder" data-index={index} data-loaded="0" style={style} aria-hidden="true" />;
  }
  // A conversation reads as its messages do: unread while any is, flagged while any is.
  const shown = row.threadCount > 1
    ? { ...row, seen: row.seen && !(row.threadUnread > 0), flagged: row.flagged || row.threadFlagged === true }
    : row;
  const onAction = (side) => {
    const kind = swipeKind(side === 'leading' ? leadingAction : trailingAction, shown);
    if (onSwipe && kind) onSwipe(kind, shown);
  };
  const spec = (action) => {
    switch (action) {
      case 'toggleRead':
        return {
          label: shown.seen ? t('mobile.actions.markUnread') : t('mobile.actions.markRead'),
          className: 'mv-swipe__act--read',
          // Desktop's glyphs show the state the message is in (quickActionIcon): open while read,
          // a filled star while starred.
          icon: <EnvelopeIcon open={shown.seen} />,
        };
      case 'delete':
        return { label: t('common.delete'), className: 'mv-swipe__act--delete', icon: <TrashIcon /> };
      case 'flag':
        return { label: shown.flagged ? t('mobile.actions.unflag') : t('mobile.actions.flag'), className: 'mv-swipe__act--flag', icon: <FlagIcon filled={shown.flagged} /> };
      case 'move':
        return { label: t('mobile.actions.move'), className: 'mv-swipe__act--move', icon: <MoveIcon /> };
      default:
        return null;
    }
  };
  return (
    <div className="mv-row-slot" data-index={index} data-loaded="1" style={style} onClick={() => onOpen(row, index)}>
      <SwipeRow
        key={row.accountId ? accountRowKey(row.accountId, row.uid) : row.uid}
        initialOpen={initialSwipe}
        onAction={onAction}
        leading={spec(leadingAction)}
        trailing={spec(trailingAction)}
      >
        <RowFace row={row} shown={shown} prefs={prefs} account={account}
          tags={<TagChips accountId={row.accountId || accountId} folder={row.folder || folder} uid={row.uid} />} />
      </SwipeRow>
    </div>
  );
}

export { senderOf };
export default memo(MessageRow);
