import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { useMailStore } from '../../stores/mailStore';
import { openNotificationTarget } from '../../utils/notificationOpen';
import { formatDateOnly, formatMonthYear } from '../../utils/dateFormat';
import { mailboxLabel } from '../../utils/imapUtf7';

const DIRECTIONS = ['all', 'received', 'sent', 'cc', 'other'];
const SEARCH_DELAY_MS = 300;

export function PersonMail({ onOpenMail }) {
  const t = useT();
  const selectedId = usePeopleStore((s) => s.selectedId);
  const mail = usePeopleStore((s) => s.mail);
  const mailNext = usePeopleStore((s) => s.mailNext);
  const loadMail = usePeopleStore((s) => s.loadMail);
  const loadMoreMail = usePeopleStore((s) => s.loadMoreMail);
  const accounts = useMailStore((s) => s.accounts);
  const [direction, setDirection] = useState('all');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    loadMail({ ...(direction !== 'all' && { direction }), ...(query && { text: query }) });
  }, [selectedId, direction, query, loadMail]);

  // Leave the Contacts view first (it drops the mail selection), then open the message.
  const open = async (row) => {
    onOpenMail?.();
    await openNotificationTarget({ accountId: row.accountId, mailbox: row.mailboxPath, uid: row.uid }, useMailStore.getState);
  };

  let lastMonth = '';
  return (
    <div className="p-4 flex flex-col gap-3" data-testid="person-mail">
      <div className="flex items-center gap-2">
        <select data-testid="mail-direction" value={direction} onChange={(e) => setDirection(e.target.value)} className="rounded border border-mail-border bg-mail-bg px-1 py-1 text-sm">
          {DIRECTIONS.map((d) => <option key={d} value={d}>{t(`contacts.mail.dir.${d}`)}</option>)}
        </select>
        <input data-testid="mail-search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('contacts.mail.search')} aria-label={t('contacts.mail.search')} className="flex-1 rounded px-2 py-1 border border-mail-border bg-mail-bg" />
      </div>
      {mail.length === 0 ? (
        <p className="text-sm text-mail-text-secondary" data-testid="mail-empty">{t('contacts.mail.empty')}</p>
      ) : (
        <ul>
          {mail.map((row) => {
            const when = new Date(row.sortMs);
            const month = `${when.getFullYear()}-${when.getMonth() + 1}`;
            const header = month !== lastMonth;
            lastMonth = month;
            const account = accounts?.find((a) => a.id === row.accountId);
            return (
              <li key={`${row.accountId}:${row.mailboxPath}:${row.uid}`}>
                {header && <h3 className="mt-3 mb-1 text-xs font-semibold uppercase text-mail-text-secondary" data-testid="mail-month">{formatMonthYear(when.getFullYear(), when.getMonth() + 1)}</h3>}
                <button type="button" data-testid={`mail-row-${row.accountId}-${row.uid}`} onClick={() => open(row)} className="w-full flex items-center gap-3 py-2 text-left">
                  <span className="text-xs rounded px-1.5 py-0.5 bg-mail-surface-hover" data-testid="mail-direction-badge">{t(`contacts.mail.dir.${row.direction}`)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{row.subject || t('contacts.mail.noSubject')}</span>
                    <span className="block truncate text-xs text-mail-text-secondary">{[account?.email, mailboxLabel(row.mailboxPath)].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="text-xs text-mail-text-secondary tabular-nums">{formatDateOnly(row.sortMs, { alwaysShowYear: true })}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {mailNext && <button type="button" data-testid="mail-more" onClick={loadMoreMail} className="self-start text-sm">{t('contacts.mail.more')}</button>}
    </div>
  );
}
