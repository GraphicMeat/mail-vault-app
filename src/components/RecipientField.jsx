import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ContactsPickerButton, ContactsAutocomplete } from './ContactsPicker';
import { Private } from './privacy/Private';
import { usePrivateAttr, usePrivateInputClass } from '../hooks/usePrivacy';
import { useT } from '../i18n/index.js';
import {
  addRecipients, isValidRecipient, joinRecipients, parseRecipientText, removeRecipient, splitRecipientField,
} from '../utils/recipientTokens';

/// An input method (Japanese, Korean, Chinese) confirms a candidate with
/// Enter while composing: that key belongs to it, not to the chips.
const composing = event => event.nativeEvent?.isComposing || event.keyCode === 229;

const CHIP = 'group flex items-center gap-1 px-2 py-0.5 bg-mail-surface border rounded-lg text-sm text-mail-text';

/**
 * To / Cc / Bcc row: every committed address is a chip with an x, the input
 * after them takes the next one, like the search box's tags.
 *
 * `value` stays the comma-joined string the rest of compose reads. The text
 * after its last separator is the draft being typed (so Send never loses an
 * uncommitted address); until the user types, the whole value is chips, which
 * is how a reply's prefilled `to` shows without being rewritten.
 *
 * - Enter, `,`, `;`, a space after an address, or leaving the field commits.
 * - Pasting an address, a list or a `mailto:` link commits them at once,
 *   `mailto:` and `?subject=…` dropped.
 * - Backspace in the empty input selects the last chip; there Backspace or
 *   Delete removes it.
 */
export function RecipientField({ name, label, placeholder, value, setValue, testid, boostAccountId, autoFocus = false }) {
  const t = useT();
  const pa = usePrivateAttr();
  const privateInput = usePrivateInputClass();
  const inputRef = useRef(null);
  const chipRefs = useRef([]);
  const [typing, setTyping] = useState(false);

  const { chips: head, draft: open } = splitRecipientField(value);
  const chips = typing ? head : [...head, open.trim()].filter(Boolean);
  const draft = typing ? open : '';
  const chipsValue = joinRecipients(chips);
  // What the contacts list sees: only the draft is a partial token.
  const listValue = typing ? value : chipsValue;

  const focusInput = () => inputRef.current?.focus();
  const focusChip = index => (chipRefs.current[index] ? chipRefs.current[index].focus() : focusInput());
  const commit = text => setValue(addRecipients(chipsValue, text));
  const remove = index => setValue(removeRecipient(value, index, { keepDraft: typing }));

  const onChange = event => {
    const text = event.target.value;
    setTyping(true);
    const separated = splitRecipientField(text).chips.length > 0;
    const spaced = /\s$/.test(text) && isValidRecipient(text.trim());
    setValue(separated || spaced ? addRecipients(chipsValue, text) : chipsValue + text);
  };

  const onKeyDown = event => {
    // The contacts list claims Enter for its highlighted suggestion first.
    if (composing(event) || event.defaultPrevented) return;
    if (event.key === 'Enter' && draft.trim()) {
      event.preventDefault();
      commit(draft);
    } else if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && !draft && chips.length) {
      event.preventDefault();
      focusChip(chips.length - 1);
    }
  };

  const onPaste = event => {
    const text = event.clipboardData?.getData('text') || '';
    const parsed = parseRecipientText(text);
    // A plain word pastes into the draft like any input; addresses become chips.
    const addressy = /mailto:/i.test(text) || parsed.length > 1 || (parsed.length === 1 && isValidRecipient(parsed[0]));
    if (!addressy) return;
    event.preventDefault();
    const el = event.target;
    const before = draft.slice(0, el.selectionStart ?? draft.length);
    const after = draft.slice(el.selectionEnd ?? draft.length);
    setTyping(true);
    setValue(addRecipients(chipsValue, [before, text, after].join('\n')));
  };

  const onChipKeyDown = (event, index) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      remove(index);
      if (index > 0) focusChip(index - 1);
      else focusInput();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusChip(index + 1 < chips.length ? index + 1 : -1);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      focusInput();
    }
  };

  chipRefs.current.length = chips.length;

  return (
    <div className="flex items-start gap-2 relative">
      <label className="w-16 flex-shrink-0 pt-1 text-sm text-mail-text-muted">{label}</label>
      <div
        className="flex-1 min-w-0 flex items-start gap-1"
        onMouseDown={event => {
          // A click on the row's empty space types into it, as on an input.
          if (event.target === event.currentTarget || event.target.dataset?.chipRow) {
            event.preventDefault();
            focusInput();
          }
        }}
      >
        <div data-chip-row="true" className="flex flex-1 min-w-0 flex-wrap items-center gap-1">
          {chips.map((chip, index) => {
            const valid = isValidRecipient(chip);
            return (
              <span
                key={`${chip}#${index}`}
                data-testid="recipient-chip"
                data-invalid={valid ? undefined : 'true'}
                className={`${CHIP} ${valid ? 'border-mail-border' : 'border-mail-danger'}`}
              >
                <button
                  ref={node => { chipRefs.current[index] = node; }}
                  type="button"
                  data-testid="recipient-chip-text"
                  title={pa(chip, 'email')}
                  onKeyDown={event => onChipKeyDown(event, index)}
                  className="max-w-[16rem] truncate rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-mail-accent"
                >
                  <Private kind="email">{chip}</Private>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="recipient-chip-remove"
                  aria-label={t('search.tags.remove', { tag: pa(chip, 'email') })}
                  onClick={() => {
                    remove(index);
                    focusInput();
                  }}
                  className="p-0.5 rounded hover:bg-mail-border transition-colors"
                >
                  <X size={12} className="text-mail-text-muted" />
                </button>
              </span>
            );
          })}
          <input
            aria-label={label}
            ref={inputRef}
            type="text"
            name={name}
            data-testid={testid}
            // The whole field's string: the input itself only holds the draft.
            data-value={value}
            data-autofocus={autoFocus ? true : undefined}
            autoComplete="off"
            value={draft}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              if (draft.trim()) commit(draft);
              setTyping(false);
            }}
            placeholder={chips.length ? undefined : placeholder}
            className={`${privateInput} flex-1 min-w-[8rem] bg-transparent text-mail-text placeholder-mail-text-muted
                      outline-none text-sm py-1`}
          />
        </div>
        <ContactsPickerButton value={listValue} onChange={setValue} fieldName={label} boostAccountId={boostAccountId} />
      </div>
      <ContactsAutocomplete value={listValue} onChange={setValue} inputRef={inputRef} boostAccountId={boostAccountId} />
    </div>
  );
}
