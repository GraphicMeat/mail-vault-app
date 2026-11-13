// One list row. Fixed height (ROW_HEIGHT) so the virtualizer positions rows from the estimate
// alone and never measures. Text goes through the same display helpers the desktop row uses.
// The row swipes (SwipeRow.jsx). What each side does is a preference: swiping right reveals the
// leading side (`swipeRightAction`, toggle read by default), swiping left the trailing side
// (`swipeLeftAction`, delete by default); `none` leaves that side still. `onSwipe(kind, row)` gets
// `seen`, `unseen`, `flag`, `unflag`, `delete` or `move`.
// Deliberately not built on src/components/EmailRow: that pulls in the desktop stores.
import React, { memo } from 'react';
import { displayText } from '../utils/bidiText.js';
import { cleanPreviewText } from '../utils/previewText.js';
import { formatEmailDate } from './format.js';
import { t as translate, useT } from './i18n.js';
import SwipeRow from './SwipeRow.jsx';
import { accountColor } from './accountColor.js';
import { EnvelopeIcon, TrashIcon, FlagIcon, MoveIcon } from './icons.jsx';
import { useMobileStore } from './store.js';
import { swipeKind } from './prefs.js';

/** Row height in px: three lines of text plus padding; well over the 44px tap minimum. */
export const ROW_HEIGHT = 76;

function senderOf(row, t = translate) {
  return displayText(row.fromName, '') || displayText(row.fromAddress, '') || t('explorer.unknownSender');
}

/** `account`: set in All Inboxes, where the row starts with a dot in that account's colour. */
function MessageRow({ row, index, start = 0, onOpen, onSwipe, initialSwipe = null, account = null }) {
  const t = useT();
  const leadingAction = useMobileStore((s) => s.prefs.swipeRightAction);
  const trailingAction = useMobileStore((s) => s.prefs.swipeLeftAction);
  const dates = useMobileStore((s) => s.prefs);
  const style = { height: `${ROW_HEIGHT}px`, transform: `translateY(${start}px)` };
  if (!row) {
    return <div className="mv-row-slot mv-row--placeholder" data-index={index} data-loaded="0" style={style} aria-hidden="true" />;
  }
  const unread = !row.seen;
  const onAction = (side) => {
    const kind = swipeKind(side === 'leading' ? leadingAction : trailingAction, row);
    if (onSwipe && kind) onSwipe(kind, row);
  };
  const spec = (action) => {
    switch (action) {
      case 'toggleRead':
        return {
          label: row.seen ? t('mobile.actions.markUnread') : t('mobile.actions.markRead'),
          className: 'mv-swipe__act--read',
          icon: <EnvelopeIcon open={!row.seen} />,
        };
      case 'delete':
        return { label: t('common.delete'), className: 'mv-swipe__act--delete', icon: <TrashIcon /> };
      case 'flag':
        return { label: row.flagged ? t('mobile.actions.unflag') : t('mobile.actions.flag'), className: 'mv-swipe__act--flag', icon: <FlagIcon filled={!row.flagged} /> };
      case 'move':
        return { label: t('mobile.actions.move'), className: 'mv-swipe__act--move', icon: <MoveIcon /> };
      default:
        return null;
    }
  };
  return (
    <div className="mv-row-slot" data-index={index} data-loaded="1" style={style} onClick={() => onOpen(row, index)}>
      <SwipeRow
        key={row.accountId ? `${row.accountId}:${row.uid}` : row.uid}
        initialOpen={initialSwipe}
        onAction={onAction}
        leading={spec(leadingAction)}
        trailing={spec(trailingAction)}
      >
        <button type="button" className={unread ? 'mv-row mv-row--unread' : 'mv-row'}>
          <span className="mv-row__top">
            {account && (
              <span className="mv-row__acct" role="img" aria-label={account.email} style={{ backgroundColor: accountColor(account) }} />
            )}
            <span className="mv-row__sender" dir="auto">{senderOf(row, t)}</span>
            {row.flagged && <span className="mv-row__flag" role="img" aria-label={t('mobile.actions.flagged')} />}
            <span className="mv-row__date">{formatEmailDate(row.dateMs, undefined, dates)}</span>
          </span>
          <span className="mv-row__subject" dir="auto">{displayText(row.subject, t('common.noSubject'))}</span>
          <span className="mv-row__snippet" dir="auto">{cleanPreviewText(row.snippet)}</span>
        </button>
      </SwipeRow>
    </div>
  );
}

export { senderOf };
export default memo(MessageRow);
