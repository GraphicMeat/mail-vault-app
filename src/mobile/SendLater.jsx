// Send later (plan 4 Task 8): the sheet that picks a send time, for a new send (Compose) and for
// moving a scheduled one (the outbox's Change time). A few ready choices and a picked date and
// time, each saying when it goes: "Sends at about 08:00 when MailVault can run" (Ruling 6: the
// phone sends from the app or a background run the OS grants, never from a server, so the time
// is honest about being approximate).
//
// The rule is the engine's (core `send::schedule`): up to 5 minutes is free, up to a day needs
// Premium, further is never allowed. The sheet only spares a round trip: a free user's choice past
// 5 minutes opens the paywall on scheduled send instead, and a time past a day or already gone is
// said in place. The engine checks again and its refusal is what counts.
import React, { useMemo, useState } from 'react';
import Sheet from './Sheet.jsx';
import { formatSendTime } from './format.js';
import { openPaywall, usePremium } from './premium.js';
import { useT } from './i18n.js';

/** Core `send::schedule::FREE_DELAY_MINUTES`. */
export const FREE_DELAY_MS = 5 * 60_000;
/** Core `send::schedule::MAX_DELAY_MINUTES`. */
export const MAX_DELAY_MS = 24 * 60 * 60_000;
/** The morning choice's hour, and how far ahead it must be to be offered today. */
const MORNING_HOUR = 8;
const MORNING_LEAD_MS = 10 * 60_000;

/** The next 08:00 (local) at least 10 minutes away: always inside a day. */
export function nextMorning(now) {
  const d = new Date(now);
  d.setHours(MORNING_HOUR, 0, 0, 0);
  if (d.getTime() <= now + MORNING_LEAD_MS) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The ready choices at `now`: `{ id, at, key }`. Literal keys for the catalog tests. */
export function scheduleChoices(now) {
  return [
    { id: 'in5', at: now + FREE_DELAY_MS, key: 'mobile.schedule.in5' },
    { id: 'in1h', at: now + 60 * 60_000, key: 'mobile.schedule.in1h' },
    { id: 'morning', at: nextMorning(now), key: 'mobile.schedule.morning' },
  ];
}

/** Whether a send at `at` needs Premium (more than 5 minutes after `now`). */
export const needsPremium = (at, now) => at - now > FREE_DELAY_MS;

const pad = (n) => String(n).padStart(2, '0');
/** `ms` as a `datetime-local` value, in local time. */
function localInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What is wrong with sending at `at` (a catalog key), or null. Premium is asked separately. */
export function timeProblem(at, now) {
  if (!Number.isFinite(at) || at <= now) return 'mobile.schedule.past';
  if (at - now > MAX_DELAY_MS) return 'mobile.schedule.tooFar';
  return null;
}

/**
 * The picker. `onPick(at)` with a time the engine should accept; a locked choice closes the sheet
 * (`onClose`) and opens the paywall instead.
 */
export default function SendLater({ title, onPick, onClose }) {
  const t = useT();
  const premium = usePremium();
  const now = useMemo(() => Date.now(), []);
  const choices = useMemo(() => scheduleChoices(now), [now]);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState(null);
  const customAt = custom ? new Date(custom).getTime() : NaN;

  const choose = (at) => {
    const current = Date.now();
    const wrong = timeProblem(at, current);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    if (!premium && needsPremium(at, current)) {
      onClose();
      openPaywall('scheduledSend');
      return;
    }
    onPick(at);
  };

  return (
    <Sheet kind="sheet" label={title} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{title}</h2>
      <div className="mv-sheet__actions" data-mv-send-later>
        {choices.map((c) => {
          const locked = !premium && needsPremium(c.at, now);
          return (
            <button key={c.id} type="button" className="mv-sheet__action mv-schedule__choice" data-mv-schedule={c.id} onClick={() => choose(c.at)}>
              <span className="mv-schedule__label">
                {t(c.key)}
                {locked && <span className="mv-schedule__premium">{t('common.premium')}</span>}
              </span>
              <span className="mv-schedule__about">{t('mobile.schedule.about', { time: formatSendTime(c.at, now) })}</span>
            </button>
          );
        })}
      </div>
      <div className="mv-schedule__custom">
        <label className="mv-schedule__pick" htmlFor="mv-schedule-at">{t('mobile.schedule.pick')}</label>
        <input
          id="mv-schedule-at"
          className="mv-schedule__input"
          type="datetime-local"
          value={custom}
          min={localInput(now)}
          max={localInput(now + MAX_DELAY_MS)}
          onChange={(e) => { setCustom(e.target.value); setProblem(null); }}
        />
        {Number.isFinite(customAt) && (
          <p className="mv-schedule__about">{t('mobile.schedule.about', { time: formatSendTime(customAt, now) })}</p>
        )}
        <button type="button" className="mv-outbox__btn mv-schedule__confirm" disabled={!custom} onClick={() => choose(customAt)}>
          {t('mobile.schedule.confirm')}
        </button>
      </div>
      {problem && <p className="mv-compose__error" role="alert">{t(problem)}</p>}
      <div className="mv-sheet__actions">
        <button type="button" className="mv-sheet__action" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Sheet>
  );
}
