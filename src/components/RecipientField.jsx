import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ContactsPickerButton, ContactsAutocomplete } from './ContactsPicker';
import { Private } from './privacy/Private';
import { usePrivateAttr, usePrivateInputClass } from '../hooks/usePrivacy';
import { useT } from '../i18n/index.js';
import {
  addRecipients, isValidRecipient, joinRecipients, parseRecipientPaste, recipientDisplay, removeRecipients,
  replaceRecipient, splitRecipientField,
} from '../utils/recipientTokens';

/// An input method (Japanese, Korean, Chinese) confirms a candidate with
/// Enter while composing: that key belongs to it, not to the chips.
const composing = event => event.nativeEvent?.isComposing || event.keyCode === 229;

const CHIP = 'group flex items-center gap-1 px-2 py-0.5 bg-mail-surface border rounded-lg text-sm text-mail-text select-none';
// How far the pointer travels before a press on a chip is a drag, not a click.
const DRAG_PX = 6;

const fieldAt = event => document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-recipient-field]');

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
 *   `mailto:` and `?subject=…` dropped; its ?cc= / ?bcc= go to those fields
 *   through `onRoute(field, text)`.
 * - A chip shows the name, its tooltip the address. Clicking it edits it in
 *   place (Enter or leaving commits, Escape cancels, empty removes it).
 * - Dragging a chip onto another recipient field moves it there through
 *   `onMove(from, to, token)`. Mouse events, not HTML5 drag: the webview's
 *   native drop handling swallows those on some platforms.
 * - Shift+click (or Ctrl/Cmd+A in the empty input) selects chips; copy and
 *   cut put them on the clipboard as a comma-separated list.
 * - Backspace in the empty input selects the last chip; there Backspace or
 *   Delete removes it (the whole selection, when there is one).
 */
export function RecipientField({ name, label, placeholder, value, setValue, testid, boostAccountId, autoFocus = false, onRoute, onMove }) {
  const t = useT();
  const pa = usePrivateAttr();
  const privateInput = usePrivateInputClass();
  const inputRef = useRef(null);
  const chipRefs = useRef([]);
  const focusedChip = useRef(null);
  const justDragged = useRef(false);
  const editRef = useRef(null);
  const [typing, setTyping] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  const { chips: head, draft: open } = splitRecipientField(value);
  const chips = typing ? head : [...head, open.trim()].filter(Boolean);
  const draft = typing ? open : '';
  const chipsValue = joinRecipients(chips);
  // What the contacts list sees: only the draft is a partial token.
  const listValue = typing ? value : chipsValue;

  const focusInput = () => inputRef.current?.focus();
  const focusChip = index => (chipRefs.current[index] ? chipRefs.current[index].focus() : focusInput());
  const commit = text => setValue(addRecipients(chipsValue, text));
  const clearSelection = () => setSelected(selected.size ? new Set() : selected);
  const removeAt = indices => {
    setValue(removeRecipients(value, indices, { keepDraft: typing }));
    setSelected(new Set());
  };
  // The chips an action applies to: the selection, else the focused chip.
  const targets = () => (selected.size ? [...selected].sort((a, b) => a - b) : focusedChip.current === null ? [] : [focusedChip.current]);

  const startEdit = index => {
    editRef.current = { index, text: chips[index] };
    setEditing(editRef.current);
  };
  const editText = text => {
    editRef.current = { ...editRef.current, text };
    setEditing(editRef.current);
  };
  /// Ends the edit once, however it ends: Enter, Escape, or the blur that
  /// the unmounting input causes after either.
  const finishEdit = (save, refocus) => {
    const session = editRef.current;
    if (!session) return;
    editRef.current = null;
    setEditing(null);
    if (save) setValue(replaceRecipient(value, session.index, session.text, { keepDraft: typing }));
    if (refocus) focusInput();
  };

  const onChange = event => {
    const text = event.target.value;
    setTyping(true);
    clearSelection();
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
    } else if ((event.key === 'a' || event.key === 'A') && (event.metaKey || event.ctrlKey) && !draft && chips.length) {
      event.preventDefault();
      setSelected(new Set(chips.map((_, i) => i)));
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && !draft && selected.size) {
      event.preventDefault();
      removeAt([...selected]);
    } else if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && !draft && chips.length) {
      event.preventDefault();
      focusChip(chips.length - 1);
    }
  };

  const onPaste = event => {
    const text = event.clipboardData?.getData('text') || '';
    const parts = parseRecipientPaste(text);
    const total = parts.to.length + parts.cc.length + parts.bcc.length;
    // A plain word pastes into the draft like any input; addresses become chips.
    const addressy = /mailto:/i.test(text) || total > 1 || (total === 1 && isValidRecipient(parts.to[0] || parts.cc[0] || parts.bcc[0]));
    if (!addressy) return;
    event.preventDefault();
    const own = [];
    if (!onRoute) own.push(...parts.to, ...parts.cc, ...parts.bcc);
    else {
      // A mailto: pasted into Cc or Bcc keeps its To address there; each
      // other header goes to its own field.
      own.push(...(name === 'to' ? parts.to : [...parts.to, ...parts[name]]));
      for (const field of ['cc', 'bcc']) {
        if (field !== name && parts[field].length) onRoute(field, parts[field].join(', '));
      }
    }
    const el = event.target;
    const before = draft.slice(0, el.selectionStart ?? draft.length);
    const after = draft.slice(el.selectionEnd ?? draft.length);
    setTyping(true);
    setValue(addRecipients(chipsValue, [before, ...own, after].join('\n')));
  };

  const onCopy = event => {
    const indices = targets();
    if (!indices.length) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', indices.map(i => chips[i]).join(', '));
  };
  const onCut = event => {
    const indices = targets();
    if (!indices.length) return;
    onCopy(event);
    removeAt(indices);
  };

  const onChipKeyDown = (event, index) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      if (selected.size) {
        removeAt([...selected]);
        focusInput();
        return;
      }
      removeAt([index]);
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
      clearSelection();
      focusInput();
    }
  };

  const onChipClick = (event, index) => {
    if (justDragged.current) return;
    if (event.shiftKey) {
      const next = new Set(selected);
      if (!next.delete(index)) next.add(index);
      setSelected(next);
    } else startEdit(index);
  };

  const onChipMouseDown = (event, index) => {
    if (event.button !== 0 || !onMove) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const token = chips[index];
    let dragging = false;
    let hover = null;
    const setHover = target => {
      if (target === hover) return;
      hover?.removeAttribute('data-drop');
      if (target && target.dataset.recipientField !== name) target.setAttribute('data-drop', 'true');
      hover = target;
    };
    const move = e => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_PX) return;
      dragging = true;
      setHover(fieldAt(e));
    };
    const up = e => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setHover(null);
      if (!dragging) return;
      // The click that ends the press must not open the editor.
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      const to = fieldAt(e)?.dataset.recipientField;
      if (to && to !== name) onMove(name, to, token);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  chipRefs.current.length = chips.length;

  return (
    <div
      data-recipient-field={name}
      className="flex items-start gap-2 relative rounded transition-colors [&[data-drop=true]]:bg-mail-accent/10"
    >
      <label className="w-16 flex-shrink-0 pt-1 text-sm text-mail-text-muted">{label}</label>
      <div
        className="flex-1 min-w-0 flex items-start gap-1"
        onCopy={onCopy}
        onCut={onCut}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) clearSelection(); }}
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
            if (editing?.index === index) {
              return (
                <span key={`edit#${index}`} className={`${CHIP} border-mail-accent`}>
                  <input
                    data-testid="recipient-chip-edit"
                    aria-label={t('search.tags.editing')}
                    autoFocus
                    autoComplete="off"
                    value={editing.text}
                    size={Math.max(8, editing.text.length + 1)}
                    onChange={event => editText(event.target.value)}
                    onKeyDown={event => {
                      if (composing(event)) return;
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        finishEdit(true, true);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        finishEdit(false, true);
                      }
                    }}
                    onBlur={() => finishEdit(true, false)}
                    className="bg-transparent text-sm text-mail-text focus:outline-none"
                  />
                </span>
              );
            }
            const valid = isValidRecipient(chip);
            const { label: shown, address } = recipientDisplay(chip);
            return (
              <span
                key={`${chip}#${index}`}
                data-testid="recipient-chip"
                data-invalid={valid ? undefined : 'true'}
                data-selected={selected.has(index) ? 'true' : undefined}
                className={`${CHIP} ${selected.has(index) ? 'border-mail-accent bg-mail-accent/10' : valid ? 'border-mail-border' : 'border-mail-danger'}`}
              >
                <button
                  ref={node => { chipRefs.current[index] = node; }}
                  type="button"
                  data-testid="recipient-chip-text"
                  title={pa(address || chip, 'email')}
                  onMouseDown={event => onChipMouseDown(event, index)}
                  onClick={event => onChipClick(event, index)}
                  onKeyDown={event => onChipKeyDown(event, index)}
                  onFocus={() => { focusedChip.current = index; }}
                  onBlur={() => { focusedChip.current = null; }}
                  className="max-w-[16rem] truncate rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-mail-accent"
                >
                  <Private kind={address && shown !== address ? 'name' : 'email'}>{shown}</Private>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="recipient-chip-remove"
                  aria-label={t('search.tags.remove', { tag: pa(chip, 'email') })}
                  onClick={() => {
                    removeAt([index]);
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
            data-recipient-input="true"
            // The whole field's string: the input itself only holds the draft.
            data-value={value}
            data-autofocus={autoFocus ? true : undefined}
            autoComplete="off"
            value={draft}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              // Out of the field nothing is being typed, so the committed value
              // needs no trailing comma to stay chips: it reads like a list.
              if (draft.trim()) setValue(addRecipients(chipsValue, draft).replace(/,\s*$/, ''));
              setTyping(false);
            }}
            placeholder={chips.length ? undefined : placeholder}
            className={`${privateInput} flex-1 min-w-[8rem] bg-transparent text-mail-text placeholder-mail-text-muted
                      outline-none text-sm py-1`}
          />
        </div>
        <ContactsPickerButton value={listValue} onChange={setValue} fieldName={label} boostAccountId={boostAccountId} exclude={chips} />
      </div>
      <ContactsAutocomplete value={listValue} onChange={setValue} inputRef={inputRef} boostAccountId={boostAccountId} exclude={chips} />
    </div>
  );
}
