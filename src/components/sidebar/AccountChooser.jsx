import React, { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Popover } from '../ui/Popover';
import { Button } from '../ui/Button';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { useT } from '../../i18n/index.js';

/** Searchable account selection stays anchored to the current account. */
export function AccountChooser({ position, onClose, accounts, renderAccount, unifiedRow, onAddAccount }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const panelRef = useDialogA11y(true, onClose);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = accounts.filter(({ label, account }) =>
    `${label} ${account.email}`.toLocaleLowerCase().includes(normalized));
  const showUnified = !!unifiedRow && (!normalized || t('sidebar.allInboxes').toLocaleLowerCase().includes(normalized));

  const moveFocus = (event) => {
    // Keyboard interaction belongs to this picker while it covers the mail
    // view, including printable keys on results that would delete or reply.
    event.stopPropagation();
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const fromInput = event.target.tagName === 'INPUT';
    if (fromInput && (event.key === 'Home' || event.key === 'End')) return;
    const choices = [...panelRef.current.querySelectorAll('[data-account-choice], .sidebar-account-open')];
    if (!choices.length) return;
    event.preventDefault();
    const current = choices.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % choices.length
        : current <= 0 ? choices.length - 1 : current - 1;
    choices[index].focus();
    choices[index].scrollIntoView?.({ block: 'nearest' });
  };

  return <Popover open onClose={onClose} ref={panelRef} variant="panel" role="dialog"
    aria-label={t('workspace.accounts')} aria-modal="true" className="sidebar-account-chooser"
    style={position} onKeyDown={moveFocus}>
    <label className="sidebar-find-field">
      <Search size={14} aria-hidden="true" />
      <input data-autofocus type="search" aria-label={t('sidebar.findAccount')}
        placeholder={t('sidebar.findAccount')} value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="sidebar-chooser-list">
      {showUnified && unifiedRow}
      {matches.map(({ account }) => renderAccount(account, true))}
      {matches.length === 0 && !showUnified && <p className="sidebar-no-results" role="status">{t('sidebar.noAccountsFound')}</p>}
    </div>
    <div className="sidebar-chooser-footer">
      <Button variant="primary" fullWidth size="sm" data-account-choice
        onClick={() => { onClose(); onAddAccount?.(); }}><Plus size={15} />{t('sidebar.addAccount')}</Button>
    </div>
  </Popover>;
}

