// The account switcher: a bottom sheet listing every account with its inbox unread count, the
// active one checked, plus "Add account". Removing asks for a second tap on the same row.
import React, { useState } from 'react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';

/** The avatar letter: the display name's first letter, else the address's. */
export function initialOf(account) {
  const source = (account?.displayName || account?.email || '?').trim();
  return (Array.from(source)[0] || '?').toUpperCase();
}

export function Avatar({ account, small = false }) {
  return <span className={small ? 'mv-avatar mv-avatar--small' : 'mv-avatar'} aria-hidden="true">{initialOf(account)}</span>;
}

function AccountRow({ account, active, unread, onSelect, onRemove }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const name = account.displayName && account.displayName !== account.email ? account.displayName : null;

  if (confirming) {
    return (
      <li className="mv-acct mv-acct--confirm">
        <p className="mv-acct__question" dir="auto">{t('mobile.switcher.removeConfirm', { email: account.email })}</p>
        <div className="mv-acct__actions">
          <button type="button" className="mv-textbtn" disabled={removing} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="mv-textbtn mv-textbtn--danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              try {
                await onRemove(account.id);
                setConfirming(false);
              } catch {
                // The engine refused: the row stays, and the question with it, for another try.
              } finally {
                setRemoving(false);
              }
            }}
          >
            {t('common.remove')}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="mv-acct">
      <button
        type="button"
        className="mv-acct__main"
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(account.id)}
      >
        <Avatar account={account} />
        <span className="mv-acct__text">
          {name && <span className="mv-acct__name" dir="auto">{name}</span>}
          <span className={name ? 'mv-acct__email mv-acct__email--sub' : 'mv-acct__email'} dir="auto">{account.email}</span>
        </span>
        {unread > 0 && (
          <span className="mv-badge" aria-label={t('mobile.switcher.unread', { count: unread })}>{unread}</span>
        )}
        <span className="mv-acct__check" aria-hidden="true">{active ? '✓' : ''}</span>
      </button>
      <button
        type="button"
        className="mv-iconbtn mv-acct__remove"
        aria-label={t('mobile.switcher.remove', { email: account.email })}
        onClick={() => setConfirming(true)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M9 4h6m-9 3h12m-10 0 .7 12h6.6L16 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </li>
  );
}

export default function AccountSwitcher({ accounts, activeAccountId, unread, onSelect, onAdd, onRemove, onClose }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('mobile.switcher.title')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('mobile.switcher.title')}</h2>
      <ul className="mv-acct-list">
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            active={a.id === activeAccountId}
            unread={unread[a.id] || 0}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        ))}
      </ul>
      <button type="button" className="mv-sheet__add" onClick={onAdd}>
        <span className="mv-avatar mv-avatar--add" aria-hidden="true">+</span>
        {t('sidebar.addAccount')}
      </button>
    </Sheet>
  );
}
