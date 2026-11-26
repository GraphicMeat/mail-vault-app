// Follow up in compose ("Remind me if no reply"): the sheet a toolbar button opens, and the chip
// that shows a set reminder above the toolbar. The sheet says what it does in one line and lists
// Off, 1 day, 3 days and 1 week; without Premium each day count carries the Premium badge and a
// pick opens the paywall instead (the screen decides). The reminder goes with the send as
// `remindAfterDays`; the engine records it once the message went out.
import React from 'react';
import Sheet from '../Sheet.jsx';
import { BellIcon, CloseIcon } from '../icons.jsx';
import { useT } from '../i18n.js';
import { REMIND_CHOICES, remindDurationKey } from './followUp.js';

export function FollowUpSheet({ value, premium, onPick, onClose }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('compose.remind.title')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('compose.remind.title')}</h2>
      <p className="mv-sheet__text">{t('mobile.compose.followUpHint')}</p>
      <div className="mv-sheet__actions" role="radiogroup" aria-label={t('compose.remind.title')}>
        {REMIND_CHOICES.map(([days, key]) => (
          <button
            key={days}
            type="button"
            role="radio"
            aria-checked={value === days}
            className="mv-sheet__action mv-schedule__choice"
            data-mv-remind-choice={days}
            onClick={() => onPick(days)}
          >
            <span className="mv-schedule__label">
              {t(key)}
              {days > 0 && !premium && <span className="mv-schedule__premium">{t('common.premium')}</span>}
            </span>
          </button>
        ))}
        <button type="button" className="mv-sheet__action" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Sheet>
  );
}

/** "Remind me if no reply in 3 days", with a cross that clears it. */
export function FollowUpChip({ days, onClear }) {
  const t = useT();
  const key = remindDurationKey(days);
  return (
    <div className="mv-compose__followup" data-mv-followup-chip>
      <BellIcon size={16} />
      <span className="mv-compose__followup-text">{t('mobile.compose.followUpSet', { duration: key ? t(key) : String(days) })}</span>
      <button type="button" className="mv-rcpt__remove" aria-label={t('mobile.compose.followUpClear')} onClick={onClear}>
        <CloseIcon />
      </button>
    </div>
  );
}
