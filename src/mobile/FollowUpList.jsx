// "Follow up" (plan 4 Task 9): the active account's follow-up reminders (store `followUps`, from
// `mobile.followup.list`), a full-screen layer opened from the folder drawer. A reminder whose
// check found no reply ("No reply yet. Sent <date>") comes first; tapping it opens its Sent copy
// (App.jsx, the same path a notification tap takes) and marks it seen. Reminders still waiting
// show when they are due. The trailing button dismisses either.
import React, { useEffect } from 'react';
import { displayText } from '../utils/bidiText.js';
import { useMobileStore } from './store.js';
import { formatEmailDate } from './format.js';
import { useT } from './i18n.js';

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function FollowUpList({ onOpen, onClose }) {
  const t = useT();
  const followUps = useMobileStore((s) => s.followUps);
  const rows = [...followUps.filter((f) => f.state === 'due'), ...followUps.filter((f) => f.state !== 'due')];

  useEffect(() => { useMobileStore.getState().loadFollowUps(); }, []);

  return (
    <section className="mv-drafts" role="dialog" aria-modal="true" aria-label={t('mobile.followUp.title')} data-mv-followups>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" onClick={onClose}>{t('common.back')}</button>
        <h1 className="mv-compose__title">{t('mobile.followUp.title')}</h1>
      </header>
      {rows.length === 0 ? (
        <p className="mv-drafts__empty">{t('mobile.followUp.empty')}</p>
      ) : (
        <ul className="mv-drafts__list">
          {rows.map((f) => {
            const subject = displayText(f.subject, '') || t('common.noSubject');
            const due = f.state === 'due' && f.folder != null && f.uid != null;
            const when = due ? t('followUp.rowTitle', { date: formatEmailDate(f.sentAt) }) : t('mobile.followUp.remindOn', { date: formatEmailDate(f.remindAt) });
            return (
              <li key={f.id} className={`mv-drafts__item${due && !f.seen ? ' mv-followup--unseen' : ''}`} data-mv-followup={f.id}>
                <button type="button" className="mv-drafts__open" disabled={!due} onClick={() => onOpen(f)}>
                  <span className="mv-drafts__top">
                    <span className="mv-drafts__subject" dir="auto">{subject}</span>
                  </span>
                  <span className="mv-drafts__to" dir="auto">{t('followUp.to', { recipients: displayText(f.recipients, '') })}</span>
                  <span className="mv-drafts__when">{when}</span>
                </button>
                <button
                  type="button"
                  className="mv-iconbtn mv-drafts__delete"
                  aria-label={t('followUp.dismiss')}
                  onClick={() => useMobileStore.getState().dismissFollowUp(f.id)}
                >
                  <CloseIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
