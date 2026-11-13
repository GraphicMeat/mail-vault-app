// The account switcher: a bottom sheet listing every account with its inbox unread count, the
// active one checked, plus "Add account". Removing asks for a second tap on the same row. An account
// whose provider sign-in lapsed (`needsAuth`) offers "Sign in again"; `ReauthBanner` says the same
// above the message list.
import React, { useState } from 'react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';
import { errorKey } from './errors.js';
import { accountColor } from './accountColor.js';

/** The avatar letter: the display name's first letter, else the address's. */
export function initialOf(account) {
  const source = (account?.displayName || account?.email || '?').trim();
  return (Array.from(source)[0] || '?').toUpperCase();
}

/**
 * The avatar wears the account's colour (accountColor.js): the desktop's for an import, else the
 * one hashed from its address, so it matches the account's row dot in All Inboxes.
 */
export function Avatar({ account, small = false }) {
  return (
    <span className={small ? 'mv-avatar mv-avatar--small' : 'mv-avatar'} style={{ backgroundColor: accountColor(account) }} aria-hidden="true">
      {initialOf(account)}
    </span>
  );
}

function AccountRow({ account, active, unread, onSelect, onRemove, onReauth, reauthBusy }) {
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
          <span className="mv-badge" aria-label={t('mobile.unreadCount', { count: unread })}>{unread}</span>
        )}
        <span className="mv-acct__check" aria-hidden="true">{active ? '✓' : ''}</span>
      </button>
      {account.needsAuth && account.oauth !== false && onReauth && (
        <button type="button" className="mv-textbtn mv-acct__reauth" disabled={reauthBusy} onClick={() => onReauth(account.id)}>
          {t('mobile.reauth.action')}
        </button>
      )}
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

export default function AccountSwitcher({ accounts, activeAccountId, unread, onSelect, onAdd, onRemove, onReauth, reauthBusy = false, onClose }) {
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
            onReauth={onReauth}
            reauthBusy={reauthBusy}
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

/**
 * The banner above the list while `account` is parked (`needsAuth`): its provider no longer
 * honours the sign-in, so nothing syncs until the user signs in again. `state` is the store's
 * `reauthState` ({ accountId, busy, code }), shared with the switcher's "Sign in again", so a run
 * started from either shows its progress and its error here. `onReauth(id)` starts one.
 */
export function ReauthBanner({ account, state, onReauth }) {
  const t = useT();
  if (!account?.needsAuth) return null;
  // A password account whose saved password was lost (the keychain move failed twice): only
  // adding it again helps.
  if (account.oauth === false) {
    return (
      <div className="mv-reauth">
        <p className="mv-reauth__text" role="status" dir="auto">{t('mobile.reauth.passwordLost', { email: account.email })}</p>
      </div>
    );
  }
  const mine = state && state.accountId === account.id ? state : null;
  const busy = Boolean(state?.busy);
  return (
    <div className="mv-reauth">
      <p className="mv-reauth__text" role="status" dir="auto">{t('mobile.reauth.banner', { email: account.email })}</p>
      {mine?.code && !busy && <p className="mv-reauth__error" role="alert">{t(errorKey(mine.code))}</p>}
      <button type="button" className="mv-reauth__btn" disabled={busy} aria-busy={busy} onClick={() => onReauth(account.id)}>
        {mine?.busy ? t('mobile.add.signingIn') : t('mobile.reauth.action')}
      </button>
    </div>
  );
}

/**
 * The banner above the list while the server refuses `account`'s password: nothing dials it again
 * (servers block an address after a few failed logins) until the user's Retry, which the engine
 * tries exactly once. `onRetry(id)` asks for it.
 */
export function RefusedBanner({ account, onRetry }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!account?.authRefused || account.needsAuth) return null;
  return (
    <div className="mv-reauth mv-refused">
      <p className="mv-reauth__text" role="status" dir="auto">{t('mobile.refused.banner', { email: account.email })}</p>
      <button
        type="button"
        className="mv-reauth__btn"
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onRetry(account.id);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('mobile.refused.retry')}
      </button>
    </div>
  );
}
