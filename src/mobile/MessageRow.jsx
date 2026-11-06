// One list row. Fixed height (ROW_HEIGHT) so the virtualizer positions rows from the estimate
// alone and never measures. Text goes through the same display helpers the desktop row uses.
// Deliberately not built on src/components/EmailRow: that pulls in the desktop stores.
import React, { memo } from 'react';
import { displayText } from '../utils/bidiText.js';
import { cleanPreviewText } from '../utils/previewText.js';
import { formatEmailDate } from './format.js';
import { t as translate, useT } from './i18n.js';

/** Row height in px: three lines of text plus padding; well over the 44px tap minimum. */
export const ROW_HEIGHT = 76;

function senderOf(row, t = translate) {
  return displayText(row.fromName, '') || displayText(row.fromAddress, '') || t('explorer.unknownSender');
}

function MessageRow({ row, index, start = 0, onOpen }) {
  const t = useT();
  const style = { height: `${ROW_HEIGHT}px`, transform: `translateY(${start}px)` };
  if (!row) {
    return <div className="mv-row mv-row--placeholder" data-index={index} data-loaded="0" style={style} aria-hidden="true" />;
  }
  const unread = !row.seen;
  return (
    <button
      type="button"
      className={unread ? 'mv-row mv-row--unread' : 'mv-row'}
      data-index={index}
      data-loaded="1"
      style={style}
      onClick={() => onOpen(row)}
    >
      <span className="mv-row__top">
        <span className="mv-row__sender" dir="auto">{senderOf(row, t)}</span>
        <span className="mv-row__date">{formatEmailDate(row.dateMs)}</span>
      </span>
      <span className="mv-row__subject" dir="auto">{displayText(row.subject, t('common.noSubject'))}</span>
      <span className="mv-row__snippet" dir="auto">{cleanPreviewText(row.snippet)}</span>
    </button>
  );
}

export { senderOf };
export default memo(MessageRow);
