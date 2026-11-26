// The account switcher: a bottom sheet listing, with two or more accounts, All Inboxes first
// (every inbox as one list, with their unread count), then every account with its inbox unread
// count, the open one checked, plus "Add account". Removing an account lives in Settings > the
// account, not here. An account whose provider sign-in lapsed (`needsAuth`) offers "Sign in
// again"; the issue row above the message list says the same (issues/IssueRow.jsx), and an avatar
// of an account with an issue wears a warning dot. `AllInboxesIcon` (icons.jsx, re-exported
// here) is the All Inboxes glyph, also worn by the drawer while All Inboxes is open. The open row's
// check and Add account's plus are icons.
import React from 'react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';
import { accountColor } from './accountColor.js';
import { Button } from '../components/ui/Button.jsx';
import { AllInboxesIcon, CheckIcon, PlusIcon } from './icons.jsx';

export { AllInboxesIcon };

/** The avatar letter: the display name's first letter, else the address's. */
export function initialOf(account) {
  const source = (account?.displayName || account?.email || '?').trim();
  return (Array.from(source)[0] || '?').toUpperCase();
}

/**
 * The avatar wears the account's colour (accountColor.js): the desktop's for an import, else the
 * one hashed from its address, so it matches the account's row dot in All Inboxes. `issue` adds
 * the warning dot of an account that needs the user (issues/accountIssues.js).
 */
export function Avatar({ account, small = false, issue = false }) {
  return (
    <span className={small ? 'mv-avatar mv-avatar--small' : 'mv-avatar'} style={{ backgroundColor: accountColor(account) }} aria-hidden="true">
      {initialOf(account)}
      {issue && <span className="mv-avatar__dot" />}
    </span>
  );
}

/** Whether the account needs the user: a lapsed sign-in, a lost password or a refused one. */
export const hasIssue = (account) => Boolean(account?.needsAuth || account?.authRefused);

function AccountRow({ account, active, unread, onSelect, onReauth, reauthBusy }) {
  const t = useT();
  const name = account.displayName && account.displayName !== account.email ? account.displayName : null;
  return (
    <li className="mv-acct">
      <button
        type="button"
        className="mv-acct__main"
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(account.id)}
      >
        <Avatar account={account} issue={hasIssue(account)} />
        <span className="mv-acct__text">
          {name && <span className="mv-acct__name" dir="auto">{name}</span>}
          <span className={name ? 'mv-acct__email mv-acct__email--sub' : 'mv-acct__email'} dir="auto">{account.email}</span>
        </span>
        {unread > 0 && (
          <span className="mv-badge" aria-label={t('mobile.unreadCount', { count: unread })}>{unread}</span>
        )}
        <span className="mv-acct__check" aria-hidden="true">{active && <CheckIcon />}</span>
      </button>
      {account.needsAuth && account.oauth !== false && onReauth && (
        <Button variant="link" size="touch" className="flex-none font-semibold" data-mv-reauth="row" disabled={reauthBusy} onClick={() => onReauth(account.id)}>
          {t('mobile.reauth.action')}
        </Button>
      )}
    </li>
  );
}

/** All Inboxes, above the accounts: `allInboxes` is `{ unread }`, or null with fewer than two. */
function AllInboxesRow({ unread, active, onSelect }) {
  const t = useT();
  return (
    <li className="mv-acct mv-acct--all">
      <button type="button" className="mv-acct__main" data-mv-all-inboxes aria-current={active ? 'true' : undefined} onClick={onSelect}>
        <span className="mv-avatar mv-avatar--all" aria-hidden="true"><AllInboxesIcon /></span>
        <span className="mv-acct__text"><span className="mv-acct__email">{t('sidebar.allInboxes')}</span></span>
        {unread > 0 && (
          <span className="mv-badge" aria-label={t('mobile.unreadCount', { count: unread })}>{unread}</span>
        )}
        <span className="mv-acct__check" aria-hidden="true">{active && <CheckIcon />}</span>
      </button>
    </li>
  );
}

export default function AccountSwitcher({ accounts, activeAccountId, unread, onSelect, onAdd, onReauth, reauthBusy = false, onClose, allInboxes = null, allInboxesActive = false, onAllInboxes }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('mobile.switcher.title')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('mobile.switcher.title')}</h2>
      <ul className="mv-acct-list">
        {allInboxes && onAllInboxes && (
          <AllInboxesRow unread={allInboxes.unread} active={allInboxesActive} onSelect={onAllInboxes} />
        )}
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            active={!(allInboxes && allInboxesActive) && a.id === activeAccountId}
            unread={unread[a.id] || 0}
            onSelect={onSelect}
            onReauth={onReauth}
            reauthBusy={reauthBusy}
          />
        ))}
      </ul>
      <button type="button" className="mv-sheet__add" onClick={onAdd}>
        <span className="mv-avatar mv-avatar--add" aria-hidden="true"><PlusIcon /></span>
        {t('sidebar.addAccount')}
      </button>
    </Sheet>
  );
}
