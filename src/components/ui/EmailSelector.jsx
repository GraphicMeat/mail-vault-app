import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AtSign, Check, ChevronDown, Folder, Inbox, Lock, Search } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { useSettingsStore } from '../../stores/settingsStore';
import { Popover } from './Popover';
import { anchorTo } from './field';
import { accountSections, filterSections, findRow, selectableRows } from './emailSelectorModel';

/**
 * The one picker for an account or an address. Closed it reads like the
 * sidebar's account row: the account's avatar, its name over the full
 * address. Open it is a search over the accounts in sidebar order and
 * groups, each account's aliases indented under it.
 *
 * `sections` come from `accountSections` (or `useAccountSections`); values
 * are opaque, so a screen keeps whatever it stored before (id, address, or
 * Compose's "<accountId> <address>" key). `leading` rows sit above the
 * accounts (All accounts, a placeholder); `footer` is one action under them
 * (Compose's Add address).
 *
 * @param {Array<{value: string, label: string}>} [leading]
 * @param {{label: string, onClick: Function, testId?: string, title?: string}} [footer]
 */
export function EmailSelector({
  value, onChange, sections, leading = [], footer, ariaLabel, testId, placeholder = '',
  lockedLabel = '', disabled = false, variant = 'field', className = '', id,
}) {
  const t = useT();
  const pa = usePrivateAttr();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const shownSections = useMemo(() => filterSections(sections, query), [sections, query]);
  const q = query.trim().toLocaleLowerCase();
  const shownLeading = useMemo(
    () => (q ? leading.filter(row => row.label.toLocaleLowerCase().includes(q)) : leading),
    [leading, q],
  );
  const rows = useMemo(() => selectableRows(shownLeading, shownSections), [shownLeading, shownSections]);
  const picked = useMemo(() => findRow(leading, sections, value), [leading, sections, value]);

  const openWith = (seed) => {
    if (disabled) return;
    const width = triggerRef.current.getBoundingClientRect().width;
    // As wide as the field (at least 320px), never past the window.
    setPos({ ...anchorTo(triggerRef.current, 360), width: Math.min(Math.max(width, 320), window.innerWidth - 16) });
    setQuery(seed);
    const all = selectableRows(leading, sections);
    setActive(seed ? 0 : Math.max(0, all.findIndex(row => row.value === value)));
    setOpen(true);
  };
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const pick = (row) => {
    close();
    if (row.value !== value) onChange?.(row.value);
  };

  useEffect(() => {
    if (!open) return;
    const el = searchRef.current;
    el?.focus();
    el?.setSelectionRange?.(el.value.length, el.value.length);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, rows]);

  const onTriggerKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openWith('');
    } else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openWith(e.key);
    }
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[active]) pick(rows[active]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };

  const optionId = (i) => `${listId}-${i}`;
  const rowIndex = new Map(rows.map((row, i) => [row, i]));

  const renderRow = (row) => {
    const i = rowIndex.get(row);
    const selected = row.value === value;
    const locked = row.kind === 'account' && row.item.locked;
    const address = row.address ? pa(row.address, 'email') : '';
    const name = row.kind === 'leading' ? row.label : row.name ? pa(row.name, 'name') : '';
    const plain = [name, address].filter(Boolean).join(' ');
    const label = !locked || !lockedLabel ? plain
      : typeof lockedLabel === 'function' ? lockedLabel(row) : `${plain}, ${lockedLabel}`;
    return (
      <li
        key={`${row.kind}:${row.value}`}
        id={optionId(i)}
        role="option"
        aria-selected={selected}
        aria-label={label}
        data-value={row.value}
        data-kind={row.kind}
        data-address={row.address || undefined}
        data-locked={locked ? 'true' : undefined}
        data-active={i === active}
        onMouseMove={() => setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(row)}
        className={`email-selector-row${row.kind === 'alias' ? ' email-selector-alias' : ''}${i === active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`}
      >
        <RowLead row={row} />
        <RowText name={name} address={row.kind === 'leading' ? '' : address} />
        {locked && <Lock size={13} className="email-selector-lock" aria-hidden="true" />}
        {selected && <Check size={14} className="email-selector-check" aria-hidden="true" />}
      </li>
    );
  };

  const closedName = picked
    ? (picked.kind === 'leading' ? picked.label : picked.name ? pa(picked.name, 'name') : '')
    : '';
  const closedAddress = picked && picked.kind !== 'leading' ? pa(picked.address, 'email') : '';
  const raw = !picked && value ? pa(value, 'email') : '';

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        data-testid={testId}
        value={value ?? ''}
        data-value={value ?? ''}
        data-email-selector=""
        title={[closedName, closedAddress].filter(Boolean).join(' ') || raw || placeholder}
        onClick={() => (open ? close() : openWith(''))}
        onKeyDown={onTriggerKeyDown}
        className={`email-selector-trigger email-selector-${variant} ${className}`}
      >
        {picked ? <RowLead row={picked} /> : null}
        {picked
          ? <RowText name={closedName} address={closedAddress} />
          : <span className={`email-selector-text ${raw ? '' : 'email-selector-placeholder'}`}>
            <span className="email-selector-name">{raw || placeholder}</span>
          </span>}
        <ChevronDown size={14} className="email-selector-chevron" aria-hidden="true" />
      </button>
      <Popover
        open={open}
        onClose={close}
        handlesTab
        style={pos}
        className="email-selector-panel"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="email-selector-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t('emailSelector.search')}
            aria-label={t('emailSelector.search')}
            aria-controls={listId}
            aria-activedescendant={rows[active] ? optionId(active) : undefined}
            aria-autocomplete="list"
            data-testid={testId ? `${testId}-search` : undefined}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel}
          data-email-selector-list={testId || ''} className="email-selector-list">
          {rows.filter(row => row.kind === 'leading').map(renderRow)}
          {shownSections.map(section => (
            <li key={section.name ?? '\u0000'} role="presentation">
              {section.name && (
                <div className="email-selector-group" data-email-group="" role="presentation">
                  <Folder size={12} aria-hidden="true" />
                  <span>{pa(section.name, 'name')}</span>
                </div>
              )}
              <ul role="group" aria-label={section.name ? pa(section.name, 'name') : undefined}>
                {rows.filter(row => row.kind !== 'leading' && section.items.includes(row.item)).map(renderRow)}
              </ul>
            </li>
          ))}
          {rows.length === 0 && (
            <li role="presentation" className="email-selector-empty">{t('common.noMatches')}</li>
          )}
        </ul>
        {footer && (
          <div className="email-selector-footer">
            <button type="button" data-testid={footer.testId} title={footer.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { close(); footer.onClick?.(); }}>
              {footer.icon || null}
              {footer.label}
            </button>
          </div>
        )}
      </Popover>
    </>
  );
}

function RowLead({ row }) {
  if (row.kind === 'alias') return <span className="email-selector-alias-mark" aria-hidden="true"><AtSign size={14} /></span>;
  if (row.kind === 'leading') return <span className="email-selector-alias-mark" aria-hidden="true">{row.icon || <Inbox size={14} />}</span>;
  return (
    <span className="email-selector-avatar" data-email-avatar="" aria-hidden="true"
      style={{ backgroundColor: row.item.color }}>{row.item.initial}</span>
  );
}

function RowText({ name, address }) {
  return (
    <span className="email-selector-text">
      {name && <span className="email-selector-name">{name}</span>}
      {address && <span className={name ? 'email-selector-address' : 'email-selector-name'}>{address}</span>}
    </span>
  );
}

/**
 * Sections for `accounts` in the sidebar's order and groups, with its names
 * and colours. Hidden accounts stay unless `hideHidden` (a screen that lists
 * only what the sidebar shows).
 */
export function useAccountSections(accounts, { valueFor, addressOf, nameOf, aliasesOf, lockedOf, hideHidden = false } = {}) {
  const accountOrder = useSettingsStore(s => s.accountOrder);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accountGroups = useSettingsStore(s => s.accountGroups);
  const displayNames = useSettingsStore(s => s.displayNames);
  const accountColors = useSettingsStore(s => s.accountColors);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  return useMemo(() => {
    const ordered = getOrderedAccounts ? getOrderedAccounts(accounts || []) : (accounts || []);
    const shown = hideHidden ? ordered.filter(a => !hiddenAccounts?.[a.id]) : ordered;
    return accountSections(shown, { accountGroups, displayNames, accountColors, valueFor, addressOf, nameOf, aliasesOf, lockedOf });
    // valueFor/aliasesOf/lockedOf are read fresh each render by callers that pass inline functions;
    // the caller memoises `accounts` and anything they close over changes it.
  }, [accounts, accountOrder, getOrderedAccounts, accountGroups, displayNames, accountColors, hiddenAccounts, hideHidden, valueFor, addressOf, nameOf, aliasesOf, lockedOf]);
}
