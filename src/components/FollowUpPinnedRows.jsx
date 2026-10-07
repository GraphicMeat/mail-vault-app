import React from 'react';
import { Bell, X } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useFollowUpStore, followUpsInView } from '../stores/followUpStore';
import { formatEmailDate } from '../utils/dateFormat';
import { listRowGround } from '../utils/listRowGround';
import { Private } from './privacy/Private';

const NO_HIDDEN = {};

/**
 * Due follow-up reminders, pinned above an inbox list (one account's INBOX,
 * or All inboxes), in every list mode.
 *
 * Deliberately NOT rows of the list. A reminder is the user's Sent message,
 * and a list row is acted on by its (account, folder, uid): the bulk modal's
 * ranges, select-all, keyboard delete and j/k all work off the list's rows,
 * so a reminder among them was the Sent copy to every one of those actions.
 * Here a reminder has two actions only: open (the Sent message, exactly as
 * the Sent folder opens it, which also marks the reminder read) and dismiss.
 */
// listRowHeight(true, 0, density) in EmailRow.jsx: the two-line row's height,
// so a pin is as tall as the compact rows under it. Not imported: EmailRow
// brings the whole row toolkit with it.
const PIN_HEIGHT = { comfortable: 52, compact: 44 };

export function FollowUpPinnedRows({ hidden = false }) {
  const t = useT();
  const rows = useFollowUpStore(s => s.rows);
  const accounts = useMailStore(s => s.accounts);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  const unifiedFolder = useMailStore(s => s.unifiedFolder);
  const mailboxScope = useMailStore(s => s.mailboxScope);
  const selectedEmailId = useMailStore(s => s.selectedEmailId);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts) || NO_HIDDEN;
  const highlight = useSettingsStore(s => s.emailRowHighlight);
  const dense = useSettingsStore(s => s.listDensity) === 'compact';
  if (hidden) return null;
  const pinned = followUpsInView({ activeAccountId, activeMailbox, unifiedFolder, mailboxScope }, rows, hiddenAccounts, accounts);
  if (!pinned.length) return null;

  const open = (row) => {
    // The full key names the Sent folder in every view, so this is the Sent
    // folder's own open, with its own reader actions.
    const key = `${row.accountId}:${row.sentMailbox}:${row.sentUid}`;
    useMailStore.getState().selectEmail(key, 'server', row.sentMailbox, null,
      { uid: row.sentUid, messageId: row.messageId, _accountId: row.accountId, _mailbox: row.sentMailbox });
    useFollowUpStore.getState().setSeen(row.id, true);
  };

  // The two-line layout of CompactEmailRow (EmailRow.jsx): the bell where the
  // gutter sits, who it went to and when it came back on line one, the
  // subject on line two, the x at the end.
  return (
    <div data-testid="follow-up-pinned" role="list" aria-label={t('followUp.notifyTitle')}
      className="flex-shrink-0 border-b border-mail-border">
      {pinned.map(row => {
        const key = `${row.accountId}:${row.sentMailbox}:${row.sentUid}`;
        const unread = !row.seen;
        const selected = selectedEmailId === key;
        const sent = row.sentAt ? formatEmailDate(new Date(row.sentAt).toISOString()) : '';
        const weight = unread ? 'font-semibold text-mail-text' : 'text-mail-text';
        return (
          <div key={row.id} role="listitem" data-testid="follow-up-pinned-row" data-unread={String(unread)}
            aria-current={selected ? 'true' : undefined}
            title={t('followUp.rowTitle', { date: sent })}
            style={{ height: dense ? PIN_HEIGHT.compact : PIN_HEIGHT.comfortable }}
            onClick={() => open(row)}
            onKeyDown={(e) => {
              // The x's own Enter and Space are its click, not the row's.
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(row); }
            }}
            tabIndex={0}
            className={`virtual-row row-compact row-top${dense ? ' row-dense' : ''} group relative flex gap-2 px-4 border-b border-mail-border last:border-b-0 cursor-pointer
              ${listRowGround({ highlight, selected, related: false, unread })}`}>
            <div className="row-gutter row-gutter-stacked">
              <div className="row-gutter-slot">
                <Bell size={14} aria-hidden="true" className={unread ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
              </div>
            </div>
            <div className={`flex-1 min-w-0 ${dense ? 'py-0.5' : 'py-1.5'}`}>
              <div className="flex items-center gap-1.5">
                <span data-testid="follow-up-pinned-to" dir="auto" className={`truncate min-w-0 text-xs ${weight}`}>
                  <Private kind="name">{t('followUp.to', { recipients: row.recipients || '' })}</Private>
                </span>
                <span data-testid="follow-up-pinned-time" className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
                  {formatEmailDate(new Date(row.remindAt).toISOString())}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span data-testid="follow-up-pinned-subject" dir="auto" className={`flex-1 min-w-0 truncate text-sm leading-snug ${weight}`}>
                  <Private kind="text">{row.subject || t('common.noSubject')}</Private>
                </span>
              </div>
            </div>
            <button type="button" data-testid="follow-up-dismiss"
              aria-label={t('followUp.dismiss')} title={t('followUp.dismiss')}
              onClick={(e) => { e.stopPropagation(); useFollowUpStore.getState().dismiss(row.id); }}
              className="self-center flex-shrink-0 p-1 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-border">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
