// One list row. Fixed height (ROW_HEIGHT) so the virtualizer positions rows from the estimate
// alone and never measures. Text goes through the same display helpers the desktop row uses.
// The row swipes (SwipeRow.jsx): the leading edge toggles read, the trailing edge deletes;
// `onSwipe(kind, row)` gets `seen`, `unseen` or `delete`.
// Deliberately not built on src/components/EmailRow: that pulls in the desktop stores.
import React, { memo } from 'react';
import { displayText } from '../utils/bidiText.js';
import { cleanPreviewText } from '../utils/previewText.js';
import { formatEmailDate } from './format.js';
import { t as translate, useT } from './i18n.js';
import SwipeRow from './SwipeRow.jsx';
import { accountColor } from './accountColor.js';
import { EnvelopeIcon, TrashIcon } from './icons.jsx';

/** Row height in px: three lines of text plus padding; well over the 44px tap minimum. */
export const ROW_HEIGHT = 76;

function senderOf(row, t = translate) {
  return displayText(row.fromName, '') || displayText(row.fromAddress, '') || t('explorer.unknownSender');
}

/** `account`: set in All Inboxes, where the row starts with a dot in that account's colour. */
function MessageRow({ row, index, start = 0, onOpen, onSwipe, initialSwipe = null, account = null }) {
  const t = useT();
  const style = { height: `${ROW_HEIGHT}px`, transform: `translateY(${start}px)` };
  if (!row) {
    return <div className="mv-row-slot mv-row--placeholder" data-index={index} data-loaded="0" style={style} aria-hidden="true" />;
  }
  const unread = !row.seen;
  const onAction = (side) => {
    if (!onSwipe) return;
    onSwipe(side === 'leading' ? (row.seen ? 'unseen' : 'seen') : 'delete', row);
  };
  return (
    <div className="mv-row-slot" data-index={index} data-loaded="1" style={style} onClick={() => onOpen(row, index)}>
      <SwipeRow
        key={row.accountId ? `${row.accountId}:${row.uid}` : row.uid}
        initialOpen={initialSwipe}
        onAction={onAction}
        leading={{
          label: row.seen ? t('mobile.actions.markUnread') : t('mobile.actions.markRead'),
          className: 'mv-swipe__act--read',
          icon: <EnvelopeIcon open={!row.seen} />,
        }}
        trailing={{ label: t('common.delete'), className: 'mv-swipe__act--delete', icon: <TrashIcon /> }}
      >
        <button type="button" className={unread ? 'mv-row mv-row--unread' : 'mv-row'}>
          <span className="mv-row__top">
            {account && (
              <span className="mv-row__acct" role="img" aria-label={account.email} style={{ backgroundColor: accountColor(account) }} />
            )}
            <span className="mv-row__sender" dir="auto">{senderOf(row, t)}</span>
            {row.flagged && <span className="mv-row__flag" role="img" aria-label={t('mobile.actions.flagged')} />}
            <span className="mv-row__date">{formatEmailDate(row.dateMs)}</span>
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
