import React from 'react';
import { Bell, X } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useFollowUpStore, followUpsInView } from '../stores/followUpStore';
import { formatEmailDate } from '../utils/dateFormat';
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
export function FollowUpPinnedRows({ hidden = false }) {
  const t = useT();
  const rows = useFollowUpStore(s => s.rows);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  const unifiedFolder = useMailStore(s => s.unifiedFolder);
  const mailboxScope = useMailStore(s => s.mailboxScope);
  const selectedEmailId = useMailStore(s => s.selectedEmailId);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts) || NO_HIDDEN;
  if (hidden) return null;
  const pinned = followUpsInView({ activeAccountId, activeMailbox, unifiedFolder, mailboxScope }, rows, hiddenAccounts);
  if (!pinned.length) return null;

  const open = (row) => {
    // The full key names the Sent folder in every view, so this is the Sent
    // folder's own open, with its own reader actions.
    const key = `${row.accountId}:${row.sentMailbox}:${row.sentUid}`;
    useMailStore.getState().selectEmail(key, 'server', row.sentMailbox, null,
      { uid: row.sentUid, messageId: row.messageId, _accountId: row.accountId, _mailbox: row.sentMailbox });
    useFollowUpStore.getState().setSeen(row.id, true);
  };

  return (
    <div data-testid="follow-up-pinned" role="list" aria-label={t('followUp.notifyTitle')}
      className="flex-shrink-0 border-b border-mail-border bg-mail-surface">
      {pinned.map(row => {
        const key = `${row.accountId}:${row.sentMailbox}:${row.sentUid}`;
        const unread = !row.seen;
        const sent = row.sentAt ? formatEmailDate(new Date(row.sentAt).toISOString()) : '';
        return (
          <div key={row.id} role="listitem" data-testid="follow-up-pinned-row" data-unread={String(unread)}
            aria-current={selectedEmailId === key ? 'true' : undefined}
            title={t('followUp.rowTitle', { date: sent })}
            onClick={() => open(row)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(row); } }}
            tabIndex={0}
            className={`group flex items-center gap-2 px-4 h-11 cursor-pointer border-b border-mail-border last:border-b-0
              ${selectedEmailId === key ? 'bg-mail-accent/10' : 'hover:bg-mail-surface-hover'}`}>
            <Bell size={14} aria-hidden="true" className={unread ? 'text-mail-accent-text flex-shrink-0' : 'text-mail-text-muted flex-shrink-0'} />
            <span className={`w-[32%] max-w-48 truncate text-sm ${unread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
              <Private kind="text">{t('followUp.to', { recipients: row.recipients || '' })}</Private>
            </span>
            <span dir="auto" className={`flex-1 min-w-0 truncate text-sm ${unread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
              <Private kind="text">{row.subject || t('common.noSubject')}</Private>
            </span>
            <span className="text-xs text-mail-text-muted whitespace-nowrap flex-shrink-0">
              {formatEmailDate(new Date(row.remindAt).toISOString())}
            </span>
            <button type="button" data-testid="follow-up-dismiss"
              aria-label={t('followUp.dismiss')} title={t('followUp.dismiss')}
              onClick={(e) => { e.stopPropagation(); useFollowUpStore.getState().dismiss(row.id); }}
              className="flex-shrink-0 p-1 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-border">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
