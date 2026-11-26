// One account's section of the drawer while All Inboxes is open (iOS Mail's Mailboxes): a header
// (chevron, avatar with its issue dot, name, unread count) that opens and closes the account's
// folder tree. The folders are read when the section first opens; a tap on one opens that
// account's folder.
import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../i18n.js';
import { Avatar, hasIssue } from '../AccountSwitcher.jsx';
import { useMobileStore } from '../store.js';
import FolderList from './FolderList.jsx';
import { useAccountFolders } from './useAccountFolders.js';

export default function AccountSection({ account, expanded, onToggle, onSelectIn, onHold }) {
  const t = useT();
  const unread = useMobileStore((s) => s.unread[account.id] || 0);
  const { status, folders } = useAccountFolders(account.id, expanded);
  const name = account.displayName && account.displayName !== account.email ? account.displayName : account.email;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <section className="mv-drawer__section">
      <button
        type="button"
        className="mv-folder mv-drawer__acct"
        data-mv-drawer-account={account.id}
        aria-expanded={expanded}
        onClick={() => onToggle(account.id)}
      >
        <Chevron size={16} className="mv-drawer__chevron" aria-hidden="true" />
        <Avatar account={account} small issue={hasIssue(account)} />
        <span className="mv-folder__name" dir="auto">{name}</span>
        {unread > 0 && <span className="mv-folder__count" aria-label={t('mobile.unreadCount', { count: unread })}>{unread}</span>}
      </button>
      {expanded && status === 'ready' && folders.length > 0 && (
        <FolderList folders={folders} accountId={account.id} onSelect={(path) => onSelectIn(account.id, path)} onHold={(folder) => onHold(folder, account.id)} />
      )}
      {expanded && (status === 'failed' || (status === 'ready' && folders.length === 0)) && (
        <p className="mv-drawer__empty">{t('mobile.drawer.empty')}</p>
      )}
    </section>
  );
}
