import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { Popover } from './Popover';
import { FIELD_TRIGGER, anchorTo } from './field';

/**
 * A searchable single-select, tom-select style. Closed it reads as a field
 * showing the picked option's label; open it is a search box over the
 * filtered options in a portaled panel, so neither a Dialog nor Compose's
 * schedule panel clips it.
 *
 * A value missing from `options` still shows, as its raw value: an empty
 * field would look like nothing was picked when something was.
 *
 * ponytail: every match is rendered (the ~420 timezones are fine); add
 * windowing if a list ever reaches thousands.
 *
 * @param {Array<{value: string, label: string, keywords?: string[]}>} options
 */
export function Combobox({ value, options, onChange, ariaLabel, testId, placeholder = '', className = '' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const haystacks = useMemo(
    () => options.map(o => [o.label, ...(o.keywords || [])].join(' ').toLowerCase()),
    [options],
  );
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? options.filter((_, i) => haystacks[i].includes(q)) : options),
    [options, haystacks, q],
  );
  const selected = options.find(o => o.value === value);

  const openWith = (seed) => {
    setPos(anchorTo(triggerRef.current, 300));
    setQuery(seed);
    setActive(seed ? 0 : Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };
  // Stable: the Popover re-registers its Escape layer whenever onClose changes.
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const pick = (option) => {
    onChange(option.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const el = searchRef.current;
    el?.focus();
    // A seeded first letter must not end up behind the caret.
    el?.setSelectionRange?.(el.value.length, el.value.length);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, shown]);

  const onTriggerKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openWith('');
    } else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing on the closed field starts the search with that letter.
      e.preventDefault();
      e.stopPropagation();
      openWith(e.key);
    }
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(i + 1, Math.max(shown.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === 'Tab') {
      // The panel lives under body; a Tab out of it would land nowhere useful.
      e.preventDefault();
      close();
    }
  };

  const optionId = (i) => `${listId}-${i}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-testid={testId}
        data-value={value}
        title={selected?.label || value}
        onClick={() => openWith('')}
        onKeyDown={onTriggerKeyDown}
        className={`${FIELD_TRIGGER} ${className}`}
      >
        <span className={`flex-1 min-w-0 truncate ${selected || value ? '' : 'text-mail-text-muted'}`}>
          {selected?.label ?? (value || placeholder)}
        </span>
        <ChevronDown size={14} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
      </button>
      <Popover
        open={open}
        onClose={close}
        handlesTab
        style={pos}
        className="w-80 max-w-[calc(100vw-16px)]"
        // Keys typed into a portaled panel still bubble up the React tree, to
        // Compose's form and the app's shortcuts.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="px-2 pb-1">
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={placeholder}
            aria-label={ariaLabel}
            aria-controls={listId}
            aria-activedescendant={shown[active] ? optionId(active) : undefined}
            aria-autocomplete="list"
            data-testid={`${testId}-search`}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onSearchKeyDown}
            className="w-full h-8 px-2 text-sm bg-transparent text-mail-text border border-mail-border rounded-md outline-none"
          />
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto">
          {shown.map((o, i) => (
            <li
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active}
              data-testid={`${testId}-option-${o.value}`}
              onMouseMove={() => setActive(i)}
              // Keep focus in the search box; the click still selects.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              className={`px-3 py-1.5 text-sm truncate cursor-pointer
                ${i === active ? 'bg-mail-surface-hover' : ''}
                ${o.value === value ? 'text-mail-accent-text font-medium' : 'text-mail-text'}`}
            >
              {o.label}
            </li>
          ))}
          {shown.length === 0 && (
            <li role="presentation" className="px-3 py-1.5 text-sm text-mail-text-muted">{t('common.noMatches')}</li>
          )}
        </ul>
      </Popover>
    </>
  );
}
