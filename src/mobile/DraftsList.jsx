// The active account's local drafts (store `drafts`, from `mobile.drafts.list`): a full-screen
// layer opened from the folder drawer's Drafts row (All Inboxes, or an account with no Drafts
// folder). A row shows the subject (or "(No subject)"), the recipients and when it was last saved;
// tapping it reopens the draft in Compose (App.jsx), the trailing button deletes it after an inline
// confirm. The rows are `DraftRows`, which App.jsx also shows above an account's Drafts folder.
import React, { useEffect, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import { useMobileStore } from './store.js';
import { formatEmailDate } from './format.js';
import { useT } from './i18n.js';
import { BackButton, TrashIcon } from './icons.jsx';
import { Button } from '../components/ui/Button.jsx';

/** The draft rows, each with its delete and inline confirm; `className` places the list. */
export function DraftRows({ drafts, onOpen, className = 'mv-drafts__list', ...rest }) {
  const t = useT();
  const [confirm, setConfirm] = useState(null); // the id asked about
  return (
    <ul className={className} {...rest}>
      {drafts.map((d) => {
        const subject = displayText(d.subject, '') || t('common.noSubject');
        if (confirm === d.id) {
          return (
            <li key={d.id} className="mv-drafts__item mv-acct--confirm">
              <p className="mv-acct__question" dir="auto">{t('mobile.drafts.confirmDelete', { subject })}</p>
              <div className="mv-acct__actions">
                <Button variant="secondary" size="touch" onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
                <Button variant="danger" size="touch"
                  onClick={() => { setConfirm(null); useMobileStore.getState().deleteDraft(d.id); }}
                >
                  {t('common.delete')}
                </Button>
              </div>
            </li>
          );
        }
        return (
          <li key={d.id} className="mv-drafts__item" data-mv-draft={d.id}>
            <button type="button" className="mv-drafts__open" onClick={() => onOpen(d.id)}>
              <span className="mv-drafts__top">
                <span className="mv-drafts__subject" dir="auto">{subject}</span>
                <span className="mv-drafts__when">{formatEmailDate(d.updatedMs)}</span>
              </span>
              <span className="mv-drafts__to" dir="auto">{displayText(d.to, '') || t('mobile.drafts.noRecipients')}</span>
            </button>
            <Button variant="ghost" size="touch" icon aria-label={t('mobile.drafts.delete', { subject })} onClick={() => setConfirm(d.id)}>
              <TrashIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export default function DraftsList({ onOpen, onClose }) {
  const t = useT();
  const drafts = useMobileStore((s) => s.drafts);

  useEffect(() => { useMobileStore.getState().loadDrafts(); }, []);

  return (
    <section className="mv-drafts" role="dialog" aria-modal="true" aria-label={t('mobile.drafts.title')}>
      <header className="mv-compose__bar">
        <BackButton onClick={onClose} />
        <h1 className="mv-compose__title">{t('mobile.drafts.title')}</h1>
      </header>
      {drafts.length === 0 ? (
        <p className="mv-drafts__empty">{t('mobile.drafts.empty')}</p>
      ) : (
        <DraftRows drafts={drafts} onOpen={onOpen} />
      )}
    </section>
  );
}
