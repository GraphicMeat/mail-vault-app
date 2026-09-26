import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { ViewPreview } from './ViewPreview';
import { useTagStore } from '../stores/tagStore';
import { useFieldStore } from '../stores/fieldStore';
import { useMailStore } from '../stores/mailStore';
import { useUnsavedStore } from '../stores/unsavedStore';
import { useT } from '../i18n/index.js';
import { Button } from './ui/Button';
import { SettingsSection } from './ui/SettingsForm';
import { TypeaheadChips } from './ui/TypeaheadChips';
import { daemonCall } from '../services/daemonClient';
import { ViewIcon, VIEW_ICON_PRESETS } from './ViewIcon';
import { SettingRow } from './ui/SettingRow';
import { ToggleSwitch } from './ui/ToggleSwitch';

// Offered when the emoji field is focused; typing any other emoji still works.
const VIEW_EMOJIS = ['📥', '📤', '⭐', '🔥', '📌', '📎', '💼', '🏠', '💰', '🧾', '✈️', '🛒', '📦', '🎓', '❤️', '👪',
  '🎉', '🔔', '⏰', '✅', '❗', '🚀', '💡', '🔒', '📰', '💬', '📅', '🏦', '🩺', '🎮', '🐶', '🌱'];
import { ConfirmDialog } from './ConfirmDialog';
import { addGroup, addTyped, dropItem, parseGroups, parseSenders, removeGroup, removeLast, removeWord, serializeGroups, serializeQuery } from '../utils/queryGroups';
import { CALENDAR_RANGES } from '../utils/viewRange';
// The drag ghost reuses the reorder list's preview style.
import '../styles/account-settings-navigation.css';

/// Three states, not two: a filter can demand a flag, demand its absence, or
/// not care — and "not care" is what a checkbox cannot say.
const TRISTATE = [['any', null], ['yes', true], ['no', false]];

const toTri = value => (value === true ? 'yes' : value === false ? 'no' : 'any');
const fromTri = value => TRISTATE.find(([name]) => name === value)?.[1] ?? null;

/// Every operator the daemon's SQL implements. `before`/`after` compare the
/// `YYYY-MM-DD` a date field stores, so only a date field offers them.
const OPS = ['is', 'isNot', 'isSet', 'isEmpty'];
const DATE_OPS = ['before', 'after'];
/// Two operators are the whole condition: asking for a value as well would ask
/// which value is missing.
const VALUELESS = ['isSet', 'isEmpty'];
const NO_FILTER = { op: 'is', value: '' };

/// "The last N days" is resolved when the view runs, so a rolling window does
/// not rot the day after it was saved. An absolute range is the other choice,
/// and the two would contradict each other — picking one clears the other.
const WINDOWS = [7, 30, 90, 365];
/// Query suggestions per page: the top 20, then 20 more as the list scrolls.
const TERM_PAGE = 20;
/// What each part of the form is called when leaving would lose an edit to
/// it. The time range is four keys and one control, so one line.
const CHANGE_LABELS = {
  name: 'views.name', icon: 'views.icon', query: 'views.filter.query', sender: 'views.filter.sender',
  unread: 'views.filter.unread', starred: 'views.filter.starred', answered: 'views.filter.answered',
  hasAttachments: 'views.filter.attachments', toMe: 'views.filter.toMe', notFromMe: 'views.filter.notFromMe',
  accounts: 'views.filter.accounts', range: 'views.filter.within', withinDays: 'views.filter.within',
  dateFrom: 'views.filter.within', dateTo: 'views.filter.within', tags: 'views.filter.tags',
  fields: 'views.filter.fields', group: 'views.filter.group', sort: 'views.filter.sort',
  direction: 'views.filter.direction', showTimeline: 'views.showTimeline',
};
const SORTS = ['date', 'sender', 'subject'];
const DIRECTIONS = ['desc', 'asc'];

/// A stored unix second as the `YYYY-MM-DD` a date input wants, and back.
const toDateInput = seconds => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '');
const fromDateInput = text => (text ? Math.floor(new Date(`${text}T00:00:00Z`).getTime() / 1000) : null);
/// The drop target under a pointer: a word (`w:g:i`), a group (`g:g`) or the
/// OR button (`new`).
/// Only inside `root`: the query and the senders are two fields of the same
/// shape, and a word carried out of one must not land in the other.
const dropTargetAt = (event, root) => {
  const spot = document.elementFromPoint?.(event.clientX, event.clientY)?.closest('[data-drop]');
  const drop = spot && root?.contains(spot) ? spot.dataset.drop : null;
  if (!drop) return null;
  if (drop === 'new') return { g: 'new' };
  const [kind, g, i] = drop.split(':');
  return kind === 'w' ? { g: Number(g), i: Number(i) } : { g: Number(g) };
};

/// Boxes of AND-words, OR between boxes: the one shape a person can read at a
/// glance, and the one the daemon evaluates. The query words and the senders
/// both use it. `suggest` turns the input into a typeahead: `(text, offset)`
/// in, `[{ value, label, detail }]` out, never a rejection. With `pageSize`,
/// a full page means there may be more, fetched as the list is scrolled.
function QueryGroupsField({ prefix, label, placeholder, hint, groups, setGroups, input, setInput, suggest, pageSize, minChars = 1 }) {
  const t = useT();
  const root = useRef(null);
  const [suggestions, setSuggestions] = useState([]);
  /// The text being paged, how far it got, and whether a page is in flight.
  /// Replaced (not mutated) when the text changes, so a late page for old
  /// text sees it is no longer current and is dropped.
  const paging = useRef(null);
  const fetchPage = useCallback(page => {
    if (!suggest || page.busy || page.done) return;
    page.busy = true;
    void suggest(page.text, page.offset).then(found => {
      if (paging.current !== page) return;
      const first = page.offset === 0;
      page.busy = false;
      page.offset += found.length;
      page.done = !pageSize || found.length < pageSize;
      // Keyed by value: a term that moved across a page edge is listed once.
      setSuggestions(current => (first ? found
        : [...current, ...found.filter(option => !current.some(shown => shown.value === option.value))]));
    });
  }, [suggest, pageSize]);
  // Debounced. Text carrying an operator is a group being written, not one
  // word being looked up.
  useEffect(() => {
    paging.current = null;
    if (!suggest) return undefined;
    const text = input.trim();
    if (text.length < minChars || /&&|\|\||,/.test(text)) { setSuggestions([]); return undefined; }
    const page = { text, offset: 0, busy: false, done: false };
    paging.current = page;
    const timer = setTimeout(() => fetchPage(page), 120);
    return () => clearTimeout(timer);
  }, [input, suggest, minChars, fetchPage]);
  const loadMore = () => { if (paging.current) fetchPage(paging.current); };
  /// Pointer drag, not HTML5 drag and drop: Tauri's file-drop handling eats
  /// HTML5 drag events on Windows.
  const drag = useRef(null);
  const dragged = useRef(false);
  const [dropOver, setDropOver] = useState(null);
  /// What follows the pointer while a word or the OR is carried.
  const [ghost, setGhost] = useState(null);

  const allGroups = addTyped(groups, input);
  const addKeys = () => {
    if (!input.trim()) return;
    setGroups(allGroups);
    setInput('');
  };

  const startDrag = (item, text) => event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    // WebKit otherwise runs the mouse default (selection, a native drag), and a
    // drag it starts ends ours with pointercancel. The click still follows.
    event.preventDefault();
    dragged.current = false;
    drag.current = { item, label: text, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = event => {
    const current = drag.current;
    if (!current) return;
    // A few pixels of wobble is still a click.
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
    current.moved = true;
    setGhost({ label: current.label, x: event.clientX, y: event.clientY, item: current.item });
    const target = dropTargetAt(event, root.current);
    setDropOver(target ? JSON.stringify(target) : null);
  };
  const endDrag = event => {
    const current = drag.current;
    drag.current = null;
    setDropOver(null);
    setGhost(null);
    if (!current?.moved) return;
    // The click that follows a drag must not add a group.
    dragged.current = true;
    const target = event.type === 'pointerup' && dropTargetAt(event, root.current);
    if (target) setGroups(dropItem(allGroups, current.item, target));
  };
  const unlessDragged = action => () => {
    if (dragged.current) { dragged.current = false; return; }
    action();
  };
  const isOver = target => dropOver === JSON.stringify(target);
  const isCarried = (g, i) => ghost?.item.kind === 'word' && ghost.item.g === g && ghost.item.i === i;

  return <div ref={root} className="view-choice-field view-query-field">
    <label htmlFor={prefix}>{label}</label>
    <div className="view-query-groups" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {groups.map((group, g) => <Fragment key={g}>
        {g > 0 && <span className="view-query-or" aria-hidden="true">{t('views.query.or')}</span>}
        <div className={`view-query-group${isOver({ g }) ? ' is-over' : ''}`} data-drop={`g:${g}`}
          data-testid={`${prefix}-group-${g}`} role="group" aria-label={t('views.query.group', { n: g + 1 })}>
          {!group.length && <span className="view-query-empty">{t('views.query.empty')}</span>}
          {!group.length && groups.length > 1 && <button type="button" className="view-query-key-remove"
            data-testid={`${prefix}-remove-group-${g}`} aria-label={`${t('common.remove')} ${t('views.query.group', { n: g + 1 })}`}
            onClick={() => setGroups(current => removeGroup(current, g))}>
            <X size={12} aria-hidden="true" />
          </button>}
          {group.map((key, i) => <Fragment key={key}>
            {i > 0 && <span className="view-query-and" aria-hidden="true">{t('views.query.and')}</span>}
            {/* The word is the handle; only the X removes, so a press that
                wobbles is never a deletion. */}
            <span className={`view-query-key${isOver({ g, i }) ? ' is-over' : ''}${isCarried(g, i) ? ' is-dragging' : ''}`}
              data-drop={`w:${g}:${i}`} title={t('views.query.dragHint')}
              onPointerDown={startDrag({ kind: 'word', g, i }, key)}>
              {key}
              <button type="button" className="view-query-key-remove" aria-label={`${t('common.remove')} ${key}`}
                onPointerDown={event => event.stopPropagation()}
                onClick={() => setGroups(current => removeWord(current, g, i))}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          </Fragment>)}
        </div>
      </Fragment>)}
    </div>
    <div className="view-query-entry" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {suggest
        ? <TypeaheadChips id={prefix} testId={prefix} label={label} placeholder={placeholder}
          describedBy={`${prefix}-hint`} value={input} onChange={setInput} options={suggestions}
          onPick={option => setGroups(addTyped(groups, option.value))}
          onEnterText={addKeys} onBackspaceEmpty={() => setGroups(removeLast)} onBlur={addKeys}
          onLoadMore={pageSize ? loadMore : undefined} />
        : <input id={prefix} data-testid={prefix} value={input} maxLength={200}
          aria-label={label} placeholder={placeholder}
          aria-describedby={`${prefix}-hint`}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && input.trim()) { event.preventDefault(); addKeys(); } }}
          onBlur={addKeys} />}
      <button type="button" data-testid={`${prefix}-or`} data-drop="new"
        className={`view-query-or-token${isOver({ g: 'new' }) ? ' is-over' : ''}`}
        title={t('views.query.orHint')} onPointerDown={startDrag({ kind: 'or' }, `|| ${t('views.query.or')}`)}
        onClick={unlessDragged(() => { setGroups(addGroup(allGroups)); setInput(''); })}>
        || {t('views.query.or')}
      </button>
    </div>
    <p id={`${prefix}-hint`} className="view-query-hint">{hint}</p>
    {ghost && createPortal(<div className="account-settings-drag-preview" aria-hidden="true"
      data-testid={`${prefix}-ghost`} style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
      <span>{ghost.label}</span>
    </div>, document.body)}
  </div>;
}

/// `onSaved` and `onDiscard` answer the unsaved-changes prompt for the host:
/// a draft it created is kept once saved, deleted once discarded.
export function ViewEditor({ view, onClose, onSaved, onDiscard, showPreview = true, isNew = false }) {
  const t = useT();
  const saveView = useViewStore(state => state.saveView);
  const deleteView = useViewStore(state => state.deleteView);
  const tags = useTagStore(state => state.tags) || [];
  const accounts = useMailStore(state => state.accounts) || [];
  const accountId = useMailStore(state => state.activeAccountId);
  const schema = useFieldStore(state => state.fieldsFor(accountId)) || [];

  const def = view.def || {};
  // A new view opens with its stand-in name as the placeholder, not the text:
  // typing a name should not start with deleting one.
  const [name, setName] = useState(isNew ? '' : view.name || '');
  const [icon, setIcon] = useState(view.icon || 'tag');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [groups, setGroups] = useState(() => parseGroups(def.query));
  const [queryInput, setQueryInput] = useState('');
  /// Senders in the query's notation: `acme || billing && stripe`. A sender
  /// saved before groups existed is one name, spaces and all.
  const [senderGroups, setSenderGroups] = useState(() => parseSenders(def.sender));
  const [senderInput, setSenderInput] = useState('');
  const [flags, setFlags] = useState({
    unread: toTri(def.unread), starred: toTri(def.starred), answered: toTri(def.answered),
  });
  const [attachments, setAttachments] = useState(!!def.hasAttachments);
  const [toMe, setToMe] = useState(!!def.toMe);
  const [notFromMe, setNotFromMe] = useState(!!def.notFromMe);
  const [chosenAccounts, setChosenAccounts] = useState(def.accounts || []);
  /// One choice: a calendar range name, a number of days, or '' for any time.
  const [within, setWithin] = useState(def.range || (def.withinDays ? String(def.withinDays) : ''));
  const [dateFrom, setDateFrom] = useState(toDateInput(def.dateFrom));
  const [dateTo, setDateTo] = useState(toDateInput(def.dateTo));
  const [chosenTags, setChosenTags] = useState(def.tags || []);
  const [tagInput, setTagInput] = useState('');
  /// Field id → `{ op, value }`. The operator is part of what was saved: read
  /// back as a bare value, an `isNot` view would silently reopen as `is`.
  const [fieldFilters, setFieldFilters] = useState(() => Object.fromEntries(
    (def.fields || []).map(filter => [filter.fieldId, {
      op: filter.op || 'is',
      value: typeof filter.value === 'string' ? filter.value : '',
    }]),
  ));
  const [group, setGroup] = useState(def.group || '');
  const [sort, setSort] = useState(def.sort || 'date');
  const [direction, setDirection] = useState(def.direction || 'desc');
  const [showTimeline, setShowTimeline] = useState(!!def.showTimeline);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  /// Senders the index holds, in the accounts the view reads (none chosen is
  /// every account). Joined into a key so the lookup is stable across renders.
  const accountKey = (chosenAccounts.length ? chosenAccounts : accounts.map(account => account.id)).join('\n');
  const suggestSenders = useCallback(prefix => daemonCall('views.suggest_senders', {
    prefix, accounts: accountKey ? accountKey.split('\n') : [], limit: 8,
  }).then(found => (Array.isArray(found) ? found : []).map(sender => ({
    value: sender.address,
    label: sender.name || sender.address,
    detail: [sender.name ? sender.address : '', sender.count].filter(Boolean).join(' · '),
  }))).catch(() => []), [accountKey]);
  /// Words and phrases from the subjects and attachment names of the mail the
  /// view reads, most messages first, a page at a time.
  const suggestTerms = useCallback((prefix, offset) => daemonCall('views.suggest_terms', {
    prefix, accounts: accountKey ? accountKey.split('\n') : [], offset, limit: TERM_PAGE,
  }).then(found => (Array.isArray(found) ? found : []).map(term => ({
    value: term.term, label: term.term, detail: String(term.count),
  }))).catch(() => []), [accountKey]);

  const tagChips = chosenTags.map(id => tags.find(tag => tag.id === id)).filter(Boolean)
    .map(tag => ({ key: tag.id, label: tag.name, color: tag.color, testId: `view-tag-${tag.id}` }));
  const tagNeedle = tagInput.trim().toLocaleLowerCase();
  const tagOptions = tags
    .filter(tag => !chosenTags.includes(tag.id) && tag.name.toLocaleLowerCase().includes(tagNeedle))
    .map(tag => ({ value: tag.id, label: tag.name, color: tag.color, testId: `view-tag-${tag.id}` }));

  const filterFor = id => fieldFilters[id] || NO_FILTER;
  const setFilter = (id, patch) =>
    setFieldFilters(current => ({ ...current, [id]: { ...(current[id] || NO_FILTER), ...patch } }));

  /// What the form currently says, as a definition. Spread over the stored one
  /// so the parts this form does not offer — excluded mailboxes, columns — are
  /// carried through an edit rather than dropped.
  const editedDef = () => ({
    ...def,
    accounts: chosenAccounts,
    query: serializeQuery(addTyped(groups, queryInput)),
    sender: serializeGroups(addTyped(senderGroups, senderInput)) || null,
    unread: fromTri(flags.unread),
    starred: fromTri(flags.starred),
    answered: fromTri(flags.answered),
    hasAttachments: attachments,
    toMe,
    notFromMe,
    range: CALENDAR_RANGES.includes(within) ? within : null,
    withinDays: within && !CALENDAR_RANGES.includes(within) ? Number(within) : null,
    dateFrom: within ? null : fromDateInput(dateFrom),
    dateTo: within ? null : fromDateInput(dateTo),
    tags: chosenTags,
    // A field nobody touched is not a filter — an empty value still means
    // "any" — but `isSet`/`isEmpty` are filters that carry no value.
    fields: Object.entries(fieldFilters)
      .filter(([, filter]) => filter.value || VALUELESS.includes(filter.op))
      .map(([fieldId, filter]) => (VALUELESS.includes(filter.op)
        ? { fieldId, op: filter.op }
        : { fieldId, op: filter.op, value: filter.value })),
    group: group || null,
    sort,
    direction,
    showTimeline,
  });

  const edited = () => ({ ...view, name: name.trim() || (isNew ? view.name : ''), icon, def: editedDef() });

  /// Saves the form; false when it cannot (no name, or the daemon refused).
  const persist = async () => {
    // A starter carries no name of its own — the app translates it — so only a
    // view someone made needs one.
    if (!name.trim() && !view.builtin && !isNew) return false;
    setSaveError('');
    setSaving(true);
    try {
      await saveView(edited());
      return true;
    } catch (cause) {
      setSaveError(cause?.message || String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (await persist()) onClose?.(true);
  };

  /// The form as it opened, per part, and the parts that differ from it now.
  /// Typed-but-not-added words count: Save would keep them.
  const snapshot = () => ({ ...editedDef(), name: name.trim(), icon });
  const [baseline] = useState(snapshot);
  const current = snapshot();
  const changes = [...new Set(Object.keys(CHANGE_LABELS)
    .filter(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(baseline[key] ?? null))
    .map(key => t(CHANGE_LABELS[key])))];
  const answers = useRef(null);
  answers.current = {
    save: async () => { const saved = await persist(); if (saved) onSaved?.(); return saved; },
    discard: async () => { await onDiscard?.(); },
  };
  const changesKey = changes.join('\n');
  useEffect(() => {
    useUnsavedStore.getState().setGuard(changes.length
      ? { changes, save: () => answers.current.save(), discard: () => answers.current.discard() }
      : null);
    // Keyed on the list's text: a new array each render is not a new guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesKey]);
  useEffect(() => () => useUnsavedStore.getState().setGuard(null), []);

  const remove = async () => {
    setSaveError('');
    setSaving(true);
    try {
      await deleteView(view.id);
      onClose?.(true);
    } catch (cause) {
      setSaveError(cause?.message || String(cause));
    } finally {
      setSaving(false);
    }
  };

  const tri = key => <div className="view-choice-field">
    <span>{t(`views.filter.${key}`)}</span>
    <div className="view-choice-group" role="group" aria-label={t(`views.filter.${key}`)}>
      {TRISTATE.map(([value]) => <button key={value} type="button" data-testid={`view-${key}-${value}`}
        className="view-choice-button" aria-pressed={flags[key] === value}
        onClick={() => setFlags(current => ({ ...current, [key]: value }))}>
        {t(`views.tristate.${value}`)}
      </button>)}
    </div>
  </div>;

  return <form className="view-editor" data-testid="view-editor-form" onSubmit={submit}>
    <SettingsSection title={view.builtin ? viewLabel(view, t) : t('views.edit')} description={t('views.editorIntro')}>
    <div className="view-editor-row">
      <input data-testid="view-name" value={name} maxLength={80} aria-label={t('views.name')} autoFocus={isNew}
        placeholder={view.builtin ? viewLabel(view, t) : isNew ? view.name : t('views.name')}
        onChange={event => setName(event.target.value)} />
    </div>
    <div className="view-choice-field">
      <span>{t('views.icon')}</span>
      <div className="view-choice-group view-icon-choices" role="group" aria-label={t('views.icon')}>
        {VIEW_ICON_PRESETS.map(option => {
          return <button key={option} type="button" data-testid={`view-icon-${option}`}
            className="view-choice-button" aria-pressed={icon === option} onClick={() => setIcon(option)}>
            <ViewIcon icon={option} size={16} />{t(`views.iconName.${option}`)}
          </button>;
        })}
        {/* Blur on the wrapper, so Tab can move from the field into the picker. */}
        <span className="view-emoji-field"
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setEmojiOpen(false); }}
          onKeyDown={event => { if (event.key === 'Escape' && emojiOpen) { event.stopPropagation(); setEmojiOpen(false); } }}>
          <input type="text" data-testid="view-emoji" className={`view-emoji-input${icon.startsWith('emoji:') ? ' is-selected' : ''}`}
            aria-label={`${t('views.icon')} (😀)`} placeholder="😀"
            value={icon.startsWith('emoji:') ? icon.slice(6) : ''}
            onFocus={() => setEmojiOpen(true)}
            onChange={event => setIcon(event.target.value ? `emoji:${event.target.value}` : 'tag')} />
          {emojiOpen && <span className="view-emoji-picker" role="group" aria-label={t('views.icon')} data-testid="view-emoji-picker">
            {VIEW_EMOJIS.map(emoji => <button key={emoji} type="button" aria-pressed={icon === `emoji:${emoji}`}
              // mousedown would blur the input first and unmount the picker
              // before the click lands.
              onMouseDown={event => event.preventDefault()}
              onClick={() => { setIcon(`emoji:${emoji}`); setEmojiOpen(false); }}>{emoji}</button>)}
          </span>}
        </span>
      </div>
    </div>

    <QueryGroupsField prefix="view-query" label={t('views.filter.query')} placeholder={t('views.query.placeholder')}
      hint={t('views.query.hint')} groups={groups} setGroups={setGroups} input={queryInput} setInput={setQueryInput}
      suggest={suggestTerms} pageSize={TERM_PAGE} minChars={2} />

    <QueryGroupsField prefix="view-sender" label={t('views.filter.sender')} placeholder={t('views.sender.placeholder')}
      hint={t('views.sender.hint')} groups={senderGroups} setGroups={setSenderGroups} input={senderInput} setInput={setSenderInput}
      suggest={suggestSenders} />

    </SettingsSection>

    <SettingsSection title={t('views.filter.filters')} description={t('views.filtersHint')}>
    <div className="view-editor-row view-filter-choices">
      {tri('unread')}
      {tri('starred')}
      {tri('answered')}
    </div>

    <div className="view-editor-row view-filter-choices">
      {[[attachments, setAttachments, 'attachments'], [toMe, setToMe, 'toMe'], [notFromMe, setNotFromMe, 'notFromMe']]
        .map(([active, setActive, key]) => <button key={key} type="button" data-testid={`view-${key}`}
          className="view-choice-button" aria-pressed={active} onClick={() => setActive(!active)}>
          {t(`views.filter.${key}`)}
        </button>)}
    </div>

    {/* A rolling window and a fixed range are two answers to one question, so
        choosing a window puts the two dates away rather than filtering by
        both. */}
    <div className="view-editor-row">
      <label>
        {t('views.filter.within')}
        <select data-testid="view-within" value={within} aria-label={t('views.filter.within')}
          onChange={event => setWithin(event.target.value)}>
          <option value="">{t('views.within.any')}</option>
          {[...WINDOWS, ...CALENDAR_RANGES].map(key => <option key={key} value={key}>{t(`views.within.${key}`)}</option>)}
        </select>
      </label>
      {!within && <>
        <label>
          {t('common.from')}
          <input type="date" data-testid="view-date-from" value={dateFrom} aria-label={t('common.from')}
            onChange={event => setDateFrom(event.target.value)} />
        </label>
        <label>
          {t('common.to')}
          <input type="date" data-testid="view-date-to" value={dateTo} aria-label={t('common.to')}
            onChange={event => setDateTo(event.target.value)} />
        </label>
      </>}
    </div>

    {accounts.length > 1 && <div className="view-choice-field">
      <span>{t('views.filter.accounts')}</span>
      {/* No account selected is every account: a view made before a second
          account was added must not empty itself when one arrives. */}
      <div className="view-choice-group view-account-choices" role="group" aria-label={t('views.filter.accounts')}>
        <button type="button" className="view-choice-button" aria-pressed={chosenAccounts.length === 0}
          onClick={() => setChosenAccounts([])}>{t('views.filter.allAccounts')}</button>
        {accounts.map(account => <button key={account.id} type="button" data-testid={`view-account-${account.id}`}
          className="view-choice-button" aria-pressed={chosenAccounts.includes(account.id)}
          onClick={() => setChosenAccounts(current => (current.includes(account.id)
            ? current.filter(id => id !== account.id)
            : [...current, account.id]))}>{account.email}</button>)}
      </div>
    </div>}

    </SettingsSection>

    <SettingsSection title={t('views.presentation')} description={t('views.presentationHint')}>
    {/* Outside the schema block on purpose: none/sender/date need no schema,
        and an app with no account yet still has a grouping to choose. */}
    <div className="view-editor-row">
      <label>
        {t('views.filter.group')}
        <select data-testid="view-group" value={group} aria-label={t('views.filter.group')}
          onChange={event => setGroup(event.target.value)}>
          <option value="">{t('views.group.none')}</option>
          <option value="sender">{t('views.group.sender')}</option>
          <option value="date">{t('views.group.date')}</option>
          {schema.map(field => <option key={field.id} value={`field:${field.id}`}>{field.name}</option>)}
        </select>
      </label>
      <label>
        {t('views.filter.sort')}
        <select data-testid="view-sort" value={sort} aria-label={t('views.filter.sort')}
          onChange={event => setSort(event.target.value)}>
          {SORTS.map(option => <option key={option} value={option}>{t(`views.sort.${option}`)}</option>)}
        </select>
      </label>
      <label>
        {t('views.filter.direction')}
        <select data-testid="view-direction" value={direction} aria-label={t('views.filter.direction')}
          onChange={event => setDirection(event.target.value)}>
          {DIRECTIONS.map(option => <option key={option} value={option}>{t(`views.direction.${option}`)}</option>)}
        </select>
      </label>
    </div>

    <SettingRow label={t('views.showTimeline')} description={t('views.showTimelineHint')}>
      <ToggleSwitch testId="view-show-timeline" active={showTimeline}
        onClick={() => setShowTimeline(!showTimeline)} label={t('views.showTimeline')} />
    </SettingRow>

    </SettingsSection>

    {(tags.length > 0 || schema.length > 0) && <SettingsSection title={t('views.filter.more')} description={t('views.moreHint')}>
    {tags.length > 0 && <div className="view-choice-field">
      <span>{t('views.filter.tags')}</span>
      <TypeaheadChips id="view-tags" testId="view-tags" label={t('views.filter.tags')}
        placeholder={t('views.tags.placeholder')} value={tagInput} onChange={setTagInput}
        chips={tagChips} onRemove={chip => setChosenTags(current => current.filter(id => id !== chip.key))}
        options={tagOptions} onPick={option => setChosenTags(current => [...current, option.value])} />
    </div>}

    {schema.length > 0 && <div className="view-editor-row">
      <span>{t('views.filter.fields')}</span>
      {schema.map(field => <label key={field.id}>
        {field.name}
        <select data-testid={`view-field-op-${field.id}`} value={filterFor(field.id).op} aria-label={t('views.filter.op')}
          onChange={event => setFilter(field.id, { op: event.target.value })}>
          {[...OPS, ...(field.kind === 'date' ? DATE_OPS : [])]
            .map(op => <option key={op} value={op}>{t(`views.op.${op}`)}</option>)}
        </select>
        {field.options?.length
          ? <select data-testid={`view-field-${field.id}`} value={filterFor(field.id).value} aria-label={field.name}
            disabled={VALUELESS.includes(filterFor(field.id).op)}
            onChange={event => setFilter(field.id, { value: event.target.value })}>
            <option value="">{t('views.tristate.any')}</option>
            {field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <input data-testid={`view-field-${field.id}`} value={filterFor(field.id).value} maxLength={200}
            aria-label={field.name} disabled={VALUELESS.includes(filterFor(field.id).op)}
            onChange={event => setFilter(field.id, { value: event.target.value })} />}
      </label>)}
    </div>}

    </SettingsSection>}

    {showPreview && <SettingsSection title={t('views.preview.title')} description={t('views.previewHint')}><ViewPreview def={editedDef()} /></SettingsSection>}

    <div className="settings-editor-actions justify-end">
      <Button variant="primary" size="sm" type="submit" disabled={saving}>{t('common.save')}</Button>
      <Button variant="ghost" size="sm" type="button" onClick={() => onClose?.()}>{t('common.cancel')}</Button>
      <Button variant="dangerTint" size="sm" type="button" data-testid="view-delete"
        disabled={saving} onClick={() => setConfirming(true)}>
        <Trash2 size={14} /> {t('common.delete')}
      </Button>
    </div>
    {saveError && <p role="alert" className="text-sm text-mail-danger">{saveError}</p>}
    <ConfirmDialog isOpen={confirming} onClose={() => setConfirming(false)}
      onConfirm={() => { void remove(); }} title={t('views.deleteConfirm')}
      description={saveError || viewLabel(view, t)} confirmLabel={t('views.deleteConfirm')}
      cancelLabel={t('common.cancel')} destructive loading={saving} />
  </form>;
}
