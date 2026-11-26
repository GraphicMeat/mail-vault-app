// The From sheet: every account (avatar, address, name) with its aliases indented under it. The
// open address is checked. A pick hands `{ accountId, address }` to the screen, which moves the
// compose to that account when it is another one. Each account's aliases come from its settings
// (`loadSettings(accountId)`, cached by the screen), read while the sheet opens.
import React, { useEffect, useMemo, useState } from 'react';
import Sheet from '../Sheet.jsx';
import { Avatar } from '../AccountSwitcher.jsx';
import { CheckIcon } from '../icons.jsx';
import { useT } from '../i18n.js';
import { fromGroups } from './fromChoices.js';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export default function FromSheet({ accounts, current, loadSettings, onPick, onClose }) {
  const t = useT();
  const [loaded, setLoaded] = useState(() => new Map());
  useEffect(() => {
    let live = true;
    for (const a of accounts) {
      loadSettings(a.id).then((s) => { if (live && s) setLoaded((m) => new Map(m).set(a.id, s)); });
    }
    return () => { live = false; };
  }, [accounts, loadSettings]);
  const groups = useMemo(() => fromGroups(accounts, loaded), [accounts, loaded]);

  return (
    <Sheet kind="sheet" label={t('mobile.compose.fromTitle')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('mobile.compose.fromTitle')}</h2>
      <div className="mv-acct-list" role="radiogroup" aria-label={t('mobile.compose.fromTitle')}>
        {groups.map(({ account, identities }) => {
          const name = account.displayName && account.displayName !== account.email ? account.displayName : null;
          const checked = (address) => account.id === current.accountId && same(address, current.address);
          return (
            <React.Fragment key={account.id}>
              <div className="mv-acct">
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked(account.email)}
                  className="mv-acct__main"
                  data-mv-from-choice={account.email}
                  data-mv-from-account={account.id}
                  onClick={() => onPick({ accountId: account.id, address: account.email })}
                >
                  <Avatar account={account} />
                  <span className="mv-acct__text">
                    {name && <span className="mv-acct__name" dir="auto">{name}</span>}
                    <span className={name ? 'mv-acct__email mv-acct__email--sub' : 'mv-acct__email'} dir="auto">{account.email}</span>
                  </span>
                  <span className="mv-acct__check" aria-hidden="true">{checked(account.email) && <CheckIcon />}</span>
                </button>
              </div>
              {identities.slice(1).map((i) => {
                const aliasName = i.label !== i.address ? i.label.slice(0, i.label.lastIndexOf('<')).trim() : null;
                return (
                  <div key={i.address} className="mv-acct mv-from__alias-row">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked(i.address)}
                      className="mv-acct__main"
                      data-mv-from-choice={i.address}
                      data-mv-from-account={account.id}
                      data-mv-from-alias=""
                      onClick={() => onPick({ accountId: account.id, address: i.address })}
                    >
                      <span className="mv-acct__text">
                        {aliasName && <span className="mv-acct__name" dir="auto">{aliasName}</span>}
                        <span className={aliasName ? 'mv-acct__email mv-acct__email--sub' : 'mv-acct__email'} dir="auto">{i.address}</span>
                      </span>
                      <span className="mv-acct__check" aria-hidden="true">{checked(i.address) && <CheckIcon />}</span>
                    </button>
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </Sheet>
  );
}
