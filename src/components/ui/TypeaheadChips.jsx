import React, { useCallback, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { registerPopoverLayer } from '../../hooks/useDialogA11y';

/**
 * Tom Select's typeahead multi-select, without the library: chips, an input,
 * and the matches listed under it. Arrow keys move through the matches,
 * Enter, Tab or a click picks one, Escape closes the list (only the list, not
 * the dialog around it), Backspace in an empty input removes the last chip.
 *
 * With `onEnterText`, nothing is highlighted until an arrow key moves there,
 * and Enter hands over the typed text itself: the sender field's free words.
 * Without it, typed text highlights the first match, as Tom Select does.
 *
 * `chips` is optional: the sender field draws its own grouped words, and uses
 * this for the input and its list.
 *
 * @param {Array<{key: string, label: string, color?: string, testId?: string}>} chips
 * @param {Array<{value: string, label: string, detail?: string, color?: string, testId?: string}>} options
 */
export function TypeaheadChips({
  id, testId, label, placeholder, describedBy, value, onChange, options, onPick,
  chips = [], onRemove, onEnterText, onBackspaceEmpty, onBlur,
}) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = open ? options : [];
  const listed = shown.length > 0;
  const current = active >= 0 && active < shown.length ? active : (!onEnterText && value.trim() && listed ? 0 : -1);

  // Stable: the popover layer re-registers whenever this changes.
  const close = useCallback(() => { setOpen(false); setActive(-1); }, []);
  // An open list is a layer of its own, so Escape peels it and leaves the
  // Settings dialog alone.
  useEffect(() => (listed ? registerPopoverLayer(close) : undefined), [listed, close]);

  const pick = option => {
    onPick(option);
    onChange('');
    close();
  };

  const onKeyDown = event => {
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      setOpen(true);
      setActive(Math.min(current + 1, options.length - 1));
    } else if (event.key === 'ArrowUp' && listed) {
      event.preventDefault();
      setActive(Math.max(current - 1, onEnterText ? -1 : 0));
    } else if ((event.key === 'Enter' || event.key === 'Tab') && shown[current]) {
      // Inside a form: an Enter that picks must not also submit it.
      event.preventDefault();
      pick(shown[current]);
    } else if (event.key === 'Enter' && value.trim()) {
      event.preventDefault();
      onEnterText?.(value);
      close();
    } else if (event.key === 'Backspace' && !value) {
      if (onBackspaceEmpty) onBackspaceEmpty();
      else if (chips.length) onRemove?.(chips[chips.length - 1]);
    }
  };

  return <div className="typeahead-chips">
    {chips.map(chip => <span key={chip.key} className="view-query-key typeahead-chip">
      {chip.color && <span className="typeahead-dot" style={{ background: chip.color }} aria-hidden="true" />}
      {chip.label}
      <button type="button" className="view-query-key-remove" data-testid={chip.testId}
        aria-label={`${t('common.remove')} ${chip.label}`} onClick={() => onRemove?.(chip)}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>)}
    <span className="typeahead-field">
      <input id={id} data-testid={testId} value={value} maxLength={200} autoComplete="off"
        role="combobox" aria-label={label} placeholder={placeholder} aria-describedby={describedBy}
        aria-autocomplete="list" aria-expanded={listed} aria-controls={listed ? listId : undefined}
        aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        onChange={event => { onChange(event.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => { close(); onBlur?.(); }} />
      {listed && <ul id={listId} role="listbox" aria-label={label} className="typeahead-list">
        {shown.map((option, i) => <li key={option.value} id={`${listId}-${i}`} role="option"
          aria-selected={i === current} data-active={i === current} data-testid={option.testId}
          onMouseMove={() => setActive(i)}
          // Keep focus in the input; the click still picks.
          onMouseDown={event => event.preventDefault()}
          onClick={() => pick(option)}>
          {option.color && <span className="typeahead-dot" style={{ background: option.color }} aria-hidden="true" />}
          <span className="typeahead-label">{option.label}</span>
          {option.detail && <span className="typeahead-detail">{option.detail}</span>}
        </li>)}
      </ul>}
    </span>
  </div>;
}
