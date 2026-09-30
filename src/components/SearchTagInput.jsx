import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Clock, Search, User, X } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { registerPopoverLayer } from '../hooks/useDialogA11y';
import {
  addTags, commitText, formatTag, operatorMenu, parseTag, pickOperator, removeTag, replaceTag, slashQuery,
} from '../utils/searchTags';

const keyPrefix = key => (key === '-' ? '-' : `${key}:`);

/// A tag as the chip shows it: the operator muted, its value without quotes.
function TagLabel({ tag }) {
  const { key, value } = parseTag(tag);
  if (!key) return tag;
  return <><span className="text-mail-text-muted">{keyPrefix(key)}</span>{value}</>;
}

/// Keys that stay put while other tags come and go, so a focused chip keeps
/// its focus when one before it is removed. A repeated tag (`||`) counts.
function tagKeys(tags) {
  const seen = new Map();
  return tags.map(tag => {
    const nth = (seen.get(tag) || 0) + 1;
    seen.set(tag, nth);
    return `${tag}#${nth}`;
  });
}

/// An input method (Japanese, Korean, Chinese) confirms a candidate with
/// Enter while composing: that key belongs to it, not to the tags.
const composing = event => event.nativeEvent?.isComposing || event.keyCode === 229;

const CHIP = 'flex items-center gap-1 px-2 py-0.5 bg-mail-surface border border-mail-border rounded-lg text-sm text-mail-text';

/**
 * The search box as tags: every committed term, operator and recent search
 * is a chip styled like a recent-search tag, and the input after them takes
 * the next one. The parent owns `tags` and `draft`; this owns the keys.
 *
 * - Enter commits the typed text (or the highlighted option); Enter in an
 *   empty input runs `onSubmit`.
 * - A chip's x removes it; clicking its text edits it in place (Enter or
 *   blur commits, Escape cancels, an empty edit removes it).
 * - Backspace or ArrowLeft in the empty input moves to the last chip; there
 *   Backspace/Delete removes it and the arrows move along the row.
 * - `/` at the start of a word lists the operators; picking one inserts it,
 *   waiting for its value when it takes one.
 * - While typing, the recent searches and then the index's `suggestions`
 *   are listed under the box.
 */
export function SearchTagInput({
  tags, onTagsChange, draft, onDraftChange, onSubmit, inputRef, autoFocus, label, placeholder,
  recent = [], onPickRecent, onRemoveRecent, onClearRecent, suggestions = [], header = null,
  onFocus, leading, trailing,
}) {
  const t = useT();
  const listId = useId();
  const rootRef = useRef(null);
  const rowRef = useRef(null);
  const chipRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [editing, setEditing] = useState(null);
  const editingRef = useRef(null);
  const [dismissedSlash, setDismissedSlash] = useState(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const slash = slashQuery(draft);
  const menuOpen = !!slash && dismissedSlash !== draft;
  const options = menuOpen
    ? operatorMenu(slash.filter).map(op => ({ type: 'operator', key: `op:${op.id}`, op }))
    : [
      ...recent.map(query => ({ type: 'recent', key: `recent:${query}`, query })),
      ...suggestions.map(suggestion => ({ type: 'suggestion', key: suggestion.key, suggestion })),
    ];
  const listed = open && !editing && (menuOpen ? options.length > 0 : options.length > 0 || !!header);
  // The operator list always has one highlighted, as a menu does; the
  // typeahead only once an arrow key moves there, so Enter commits the text.
  const current = active >= 0 && active < options.length ? active : (menuOpen && options.length ? 0 : -1);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
    if (slashQuery(draftRef.current)) setDismissedSlash(draftRef.current);
  }, []);
  // An open list is a layer of its own: Escape peels it and nothing else.
  useEffect(() => (listed ? registerPopoverLayer(close) : undefined), [listed, close]);
  useEffect(() => {
    const onMouseDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);
  // Past the rows the box shows, a new tag would push the input out of
  // sight: the row scrolls to its end (where the input is) as tags come and
  // go. Only the row scrolls, never the list around the bar.
  useEffect(() => {
    if (!editing && rowRef.current) rowRef.current.scrollTop = rowRef.current.scrollHeight;
  }, [tags.length, editing]);
  useEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, listId]);

  const focusInput = () => inputRef.current?.focus();
  const focusChip = index => {
    const chip = index >= 0 ? chipRefs.current[index] : null;
    if (chip) chip.focus();
    else focusInput();
  };

  const startEditing = session => {
    editingRef.current = session;
    setEditing(session);
  };
  const editText = text => {
    editingRef.current = { ...editingRef.current, text };
    setEditing(editingRef.current);
  };
  /// Ends the edit once, however it ends: Enter, Escape, or the blur that
  /// moving focus away (or unmounting the input) causes after either.
  const finishEdit = (save, refocus) => {
    const session = editingRef.current;
    if (!session) return;
    editingRef.current = null;
    setEditing(null);
    if (save) {
      const next = session.key ? [formatTag(session.key, session.text)].filter(Boolean) : commitText(session.text);
      onTagsChange(session.isNew ? addTags(tags, next) : replaceTag(tags, session.index, next));
    }
    if (refocus) focusInput();
  };

  const commitDraft = () => {
    onTagsChange(addTags(tags, commitText(draft)));
    onDraftChange('');
    setActive(-1);
  };

  const pickOperatorOption = op => {
    const base = addTags(tags, commitText(slash?.before || ''));
    onDraftChange('');
    setActive(-1);
    const picked = pickOperator(op);
    if (!picked.key) {
      onTagsChange(addTags(base, [picked.tag]));
      focusInput();
      return;
    }
    onTagsChange(base);
    startEditing({ index: base.length, key: picked.key, text: '', isNew: true });
  };

  const pick = option => {
    if (option.type === 'operator') pickOperatorOption(option.op);
    else if (option.type === 'recent') {
      setOpen(false);
      setActive(-1);
      onPickRecent?.(option.query);
    } else {
      onTagsChange(addTags(tags, option.suggestion.tags));
      onDraftChange('');
      setActive(-1);
      focusInput();
    }
  };

  const onInputKeyDown = event => {
    if (composing(event)) return;
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      setOpen(true);
      setActive(Math.min(current + 1, options.length - 1));
    } else if (event.key === 'ArrowUp' && listed) {
      event.preventDefault();
      setActive(Math.max(current - 1, menuOpen ? 0 : -1));
    } else if (event.key === 'Enter') {
      // Inside the search form: Enter is never the form's implicit submit.
      event.preventDefault();
      if (listed && options[current]) pick(options[current]);
      else if (draft.trim()) commitDraft();
      else {
        setOpen(false);
        onSubmit();
      }
    } else if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && !draft && tags.length) {
      // The less destructive half of a chip input's Backspace: select the
      // last tag; a second Backspace, on the tag, removes it.
      event.preventDefault();
      focusChip(tags.length - 1);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const onChipKeyDown = (event, index) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      onTagsChange(removeTag(tags, index));
      if (index > 0) focusChip(index - 1);
      else focusInput();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusChip(index + 1 < tags.length ? index + 1 : -1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      focusInput();
    }
  };

  const editChip = (keyName, session) => (
    <span key={keyName} data-testid="search-tag" data-editing="true" className={`${CHIP} border-mail-accent`}>
      {session.key && <span className="text-mail-text-muted">{keyPrefix(session.key)}</span>}
      <input
        data-testid="search-tag-edit"
        aria-label={t('search.tags.editing')}
        autoFocus
        value={session.text}
        size={Math.max(4, session.text.length + 1)}
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

  const keys = tagKeys(tags);
  chipRefs.current.length = tags.length;

  return (
    <div ref={rootRef} className="relative flex-1 min-w-0">
      <div
        className="flex items-start gap-2 pl-3 pr-2 py-1 bg-mail-bg border border-mail-border rounded-lg
                  focus-within:border-mail-accent transition-colors"
        onMouseDown={event => {
          // A click on the box's empty space types into it, as on an input.
          if (event.target === event.currentTarget || event.target.dataset?.tagRow) {
            event.preventDefault();
            focusInput();
          }
        }}
      >
        <span className="mt-1.5 shrink-0 text-mail-text-muted" aria-hidden="true">{leading}</span>
        {/* Many tags wrap onto more rows and then scroll, never widen the bar. */}
        <div ref={rowRef} data-tag-row="true" className="flex flex-1 min-w-0 flex-wrap items-center gap-1 max-h-24 overflow-y-auto py-0.5">
          {tags.map((tag, index) => (editing && !editing.isNew && editing.index === index
            ? editChip(keys[index], editing)
            : (
              <span key={keys[index]} data-testid="search-tag" className={`group ${CHIP} hover:border-mail-accent transition-colors`}>
                <button
                  ref={node => { chipRefs.current[index] = node; }}
                  type="button"
                  data-testid="search-tag-text"
                  aria-label={t('search.tags.edit', { tag })}
                  title={tag}
                  onClick={() => {
                    const { key, value } = parseTag(tag);
                    startEditing({ index, key, text: key ? value : tag, isNew: false });
                  }}
                  onKeyDown={event => onChipKeyDown(event, index)}
                  className="max-w-[16rem] truncate rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-mail-accent"
                >
                  <TagLabel tag={tag} />
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="search-tag-remove"
                  aria-label={t('search.tags.remove', { tag })}
                  onClick={() => {
                    onTagsChange(removeTag(tags, index));
                    focusInput();
                  }}
                  className="p-0.5 rounded hover:bg-mail-border transition-colors"
                >
                  <X size={12} className="text-mail-text-muted" />
                </button>
              </span>
            )))}
          {editing?.isNew && editChip('pending', editing)}
          <input
            ref={inputRef}
            data-testid="mail-search-input"
            type="text"
            role="combobox"
            autoFocus={autoFocus}
            autoComplete="off"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={listed}
            aria-controls={listed ? listId : undefined}
            aria-activedescendant={listed && current >= 0 ? `${listId}-${current}` : undefined}
            value={draft}
            placeholder={placeholder}
            onChange={event => {
              onDraftChange(event.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => {
              setOpen(true);
              onFocus?.();
            }}
            onKeyDown={onInputKeyDown}
            className="flex-1 min-w-[6rem] bg-transparent py-1 text-sm text-mail-text placeholder-mail-text-muted
                      focus:outline-none"
          />
        </div>
        {trailing}
      </div>

      {listed && (
        <div
          data-testid="search-dropdown"
          className="absolute left-0 right-0 top-full mt-2 bg-mail-surface border border-mail-border
                    rounded-xl z-[100] p-3 max-h-80 overflow-y-auto"
        >
          {menuOpen ? (
            <ul id={listId} role="listbox" aria-label={t('search.operators.title')} className="space-y-0.5">
              {options.map((option, index) => (
                <li
                  key={option.key}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  data-operator={option.op.id}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => pick(option)}
                  className={`flex items-baseline justify-between gap-3 px-2 py-1 rounded-lg cursor-pointer text-xs
                    ${index === current ? 'bg-mail-accent/10' : ''}`}
                >
                  <code className="font-mono text-mail-text">{option.op.syntax}</code>
                  <span className="text-mail-text-muted truncate">{t(`search.operators.${option.op.id}`)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {header}
              <div id={listId} role="listbox" aria-label={label}>
                {recent.length > 0 && (
                  <div role="group" aria-label={t('search.recentSearches')}>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-medium text-mail-text-muted flex items-center gap-1">
                        <Clock size={12} />
                        {t('search.recentSearches')}
                      </h4>
                      <button
                        type="button"
                        onMouseDown={event => event.preventDefault()}
                        onClick={onClearRecent}
                        className="text-xs text-mail-text-muted hover:text-mail-danger transition-colors"
                      >
                        {t('search.clearAll')}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {options.map((option, index) => option.type === 'recent' && (
                        <div
                          key={option.key}
                          id={`${listId}-${index}`}
                          role="option"
                          aria-selected={index === current}
                          data-testid="search-recent"
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => pick(option)}
                          className={`group flex items-center gap-1 px-2 py-1 bg-mail-bg border rounded-lg text-sm
                            text-mail-text hover:border-mail-accent cursor-pointer transition-colors
                            ${index === current ? 'border-mail-accent' : 'border-mail-border'}`}
                        >
                          <span className="max-w-[150px] truncate">{option.query}</span>
                          <button
                            type="button"
                            aria-label={t('search.tags.remove', { tag: option.query })}
                            onClick={event => {
                              event.stopPropagation();
                              onRemoveRecent?.(option.query);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-mail-border rounded transition-all"
                          >
                            <X size={12} className="text-mail-text-muted" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {suggestions.length > 0 && (
                  <div role="group" aria-label={t('search.suggestions')} className={recent.length ? 'mt-3' : ''}>
                    <h4 className="text-xs font-medium text-mail-text-muted mb-1 flex items-center gap-1">
                      <Search size={12} />
                      {t('search.suggestions')}
                    </h4>
                    <ul className="space-y-0.5">
                      {options.map((option, index) => option.type === 'suggestion' && (
                        <li
                          key={option.key}
                          id={`${listId}-${index}`}
                          role="option"
                          aria-selected={index === current}
                          data-testid="search-suggestion"
                          onMouseMove={() => setActive(index)}
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => pick(option)}
                          className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer text-sm text-mail-text
                            ${index === current ? 'bg-mail-accent/10' : ''}`}
                        >
                          {option.suggestion.kind === 'sender'
                            ? <User size={12} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
                            : <Search size={12} className="shrink-0 text-mail-text-muted" aria-hidden="true" />}
                          <span className="truncate">{option.suggestion.label}</span>
                          {option.suggestion.detail && (
                            <span className="truncate text-xs text-mail-text-muted">{option.suggestion.detail}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] text-mail-text-muted">{t('search.operators.slashTip')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
