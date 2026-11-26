// The From line's chip: the sending account's avatar, the address it sends from and a chevron.
// It opens the From sheet (FromSheet.jsx).
import React from 'react';
import { Avatar } from '../AccountSwitcher.jsx';
import { ChevronDownIcon } from '../icons.jsx';
import { useT } from '../i18n.js';

export default function FromChip({ account, address, disabled, onOpen }) {
  const t = useT();
  return (
    <button
      type="button"
      className="mv-compose__from-chip"
      data-mv-from-chip
      aria-haspopup="dialog"
      aria-label={t('mobile.compose.changeFrom', { address })}
      disabled={disabled}
      onClick={onOpen}
    >
      <Avatar account={account} small />
      <span className="mv-compose__from-address" dir="auto">{address}</span>
      <ChevronDownIcon />
    </button>
  );
}
