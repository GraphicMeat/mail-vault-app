// One recipient line of the compose screen (To, Cc or Bcc): the committed addresses as chips, then
// an input. What is typed becomes chips on a comma, a space, Enter or leaving the field; Backspace
// in an empty input takes the last chip back into it. A chip whose address does not read is marked
// (and the screen keeps Send off until it is fixed); its × removes it. The typed text is the
// parent's (`text`), so a send can commit what is still in the input.
import React, { useId } from 'react';
import { displayText } from '../utils/bidiText.js';
import { addressOf, isValidEntry, nameOf, splitTyped } from './compose.js';
import { useT } from './i18n.js';

/**
 * `text` committed onto `entries`: the new list, and what stays in the input. Without `all`, only
 * what a separator ends is committed: a comma or semicolon outside quotes and angle brackets, or
 * white space after a bare address (a pasted `"Doe, John" <j@x>` stays one entry).
 */
export function commitText(entries, text, { all = false } = {}) {
  const raw = String(text ?? '');
  let cut = all ? raw.length : 0;
  if (!all) {
    let quoted = false;
    let angled = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' && !angled) quoted = !quoted;
      else if (ch === '<' && !quoted) angled = true;
      else if (ch === '>' && !quoted) angled = false;
      else if (!quoted && !angled && (ch === ',' || ch === ';')) cut = i + 1;
      else if (!quoted && !angled && /\s/.test(ch)) {
        const seg = raw.slice(cut, i);
        if (!/["<]/.test(seg) || />\s*$/.test(seg)) cut = i + 1;
      }
    }
  }
  if (cut <= 0) return { entries, text: raw };
  const done = splitTyped(raw.slice(0, cut));
  return { entries: done.length ? [...entries, ...done] : entries, text: raw.slice(cut).replace(/^[,;\s]+/, '') };
}

export default function RecipientField({ label, entries, text, onChange, onFocus }) {
  const t = useT();
  const id = useId();

  const update = (nextEntries, nextText) => onChange({ entries: nextEntries, text: nextText });
  const onInput = (e) => {
    const r = commitText(entries, e.target.value);
    update(r.entries, r.text);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = commitText(entries, text, { all: true });
      update(r.entries, r.text);
    } else if (e.key === 'Backspace' && !text && entries.length) {
      e.preventDefault();
      update(entries.slice(0, -1), entries[entries.length - 1]);
    }
  };
  const onBlur = () => {
    const r = commitText(entries, text, { all: true });
    if (r.entries !== entries || r.text !== text) update(r.entries, r.text);
  };
  const remove = (at) => update(entries.filter((_, i) => i !== at), text);

  return (
    <div className="mv-compose__line mv-compose__line--recipients">
      <label className="mv-compose__label" htmlFor={id}>{label}</label>
      <ul className="mv-compose__chips">
        {entries.map((entry, i) => {
          const valid = isValidEntry(entry);
          const address = addressOf(entry);
          const shown = displayText(nameOf(entry), '') || displayText(address, '') || entry;
          return (
            // eslint-disable-next-line react/no-array-index-key -- the same address may be typed twice
            <li key={`${i}:${entry}`} className={`mv-rcpt${valid ? '' : ' mv-rcpt--invalid'}`} data-mv-chip aria-invalid={valid ? undefined : 'true'} title={entry}>
              <span className="mv-rcpt__text" dir="auto">{shown}</span>
              <button type="button" className="mv-rcpt__remove" aria-label={t('mobile.compose.removeRecipient', { address: address || entry })} onClick={() => remove(i)}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          );
        })}
        <li className="mv-compose__chip-input">
          <input
            id={id}
            /* Not type="email": its value sanitizing strips the space that commits an address. */
            type="text"
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="email"
            spellCheck={false}
            value={text}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onFocus={onFocus}
          />
        </li>
      </ul>
    </div>
  );
}
