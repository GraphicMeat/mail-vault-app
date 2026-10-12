import React, { useEffect, useRef } from 'react';
import { getAccountColor, getAccountInitial, useSettingsStore } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { setHoveredAccount, clearHoveredAccount } from '../stores/accountHoverStore';
import { usePrivateAttr } from '../hooks/usePrivacy';

/**
 * The account a row's message lives in, drawn as the sidebar draws it: initial
 * on the account's colour. Shown on rows of a view that spans accounts.
 */
export function AccountBadge({ email, accountColors }) {
  const pa = usePrivateAttr();
  const displayName = useSettingsStore(s => s.displayNames?.[email._accountId]);
  const account = useMailStore(s => s.accounts?.find(a => a.id === email._accountId)) || { id: email._accountId, email: email._accountEmail };
  return (
    <span
      data-testid="account-dot"
      data-account-id={email._accountId}
      className="w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-white text-[9px] font-bold leading-none select-none"
      style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
      title={pa(email._accountEmail, 'email')}
      aria-hidden="true"
    >
      {getAccountInitial(account, displayName)}
    </span>
  );
}

/**
 * Pointer handlers for a row in a spanning view: point at the row, light its
 * account in the sidebar. `enabled` is false in a single-account view.
 */
export function useAccountHover(accountId, enabled) {
  const mine = useRef(false);
  useEffect(() => () => { if (mine.current) clearHoveredAccount(accountId); }, [accountId]);
  if (!enabled || !accountId) return {};
  return {
    onMouseEnter: () => { mine.current = true; setHoveredAccount(accountId); },
    onMouseLeave: () => { mine.current = false; clearHoveredAccount(accountId); },
  };
}
