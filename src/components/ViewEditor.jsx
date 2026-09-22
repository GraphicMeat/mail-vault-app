import React, { useState } from 'react';
import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { ViewPreview } from './ViewPreview';
import { useTagStore } from '../stores/tagStore';
import { useFieldStore } from '../stores/fieldStore';
import { useMailStore } from '../stores/mailStore';
import { useT } from '../i18n/index.js';

const ICONS = ['tag', 'star', 'paperclip', 'reply', 'inbox'];
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
const SORTS = ['date', 'sender', 'subject'];
const DIRECTIONS = ['desc', 'asc'];

/// A stored unix second as the `YYYY-MM-DD` a date input wants, and back.
const toDateInput = seconds => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '');
const fromDateInput = text => (text ? Math.floor(new Date(`${text}T00:00:00Z`).getTime() / 1000) : null);

export function ViewEditor({ view, onClose, showPreview = true }) {
  const t = useT();
  const saveView = useViewStore(state => state.saveView);
  const deleteView = useViewStore(state => state.deleteView);
  const moveView = useViewStore(state => state.moveView);
  const tags = useTagStore(state => state.tags) || [];
  const accounts = useMailStore(state => state.accounts) || [];
  const accountId = useMailStore(state => state.activeAccountId);
  const schema = useFieldStore(state => state.fieldsFor(accountId)) || [];

  const def = view.def || {};
  const [name, setName] = useState(view.name || '');
  const [icon, setIcon] = useState(view.icon || 'tag');
  const [query, setQuery] = useState(def.query || '');
  const [sender, setSender] = useState(def.sender || '');
  const [flags, setFlags] = useState({
    unread: toTri(def.unread), starred: toTri(def.starred), answered: toTri(def.answered),
  });
  const [attachments, setAttachments] = useState(!!def.hasAttachments);
  const [toMe, setToMe] = useState(!!def.toMe);
  const [notFromMe, setNotFromMe] = useState(!!def.notFromMe);
  const [chosenAccounts, setChosenAccounts] = useState(def.accounts || []);
  const [withinDays, setWithinDays] = useState(def.withinDays ? String(def.withinDays) : '');
  const [dateFrom, setDateFrom] = useState(toDateInput(def.dateFrom));
  const [dateTo, setDateTo] = useState(toDateInput(def.dateTo));
  const [chosenTags, setChosenTags] = useState(def.tags || []);
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
  const [confirming, setConfirming] = useState(false);

  const filterFor = id => fieldFilters[id] || NO_FILTER;
  const setFilter = (id, patch) =>
    setFieldFilters(current => ({ ...current, [id]: { ...(current[id] || NO_FILTER), ...patch } }));

  /// What the form currently says, as a definition. Spread over the stored one
  /// so the parts this form does not offer — excluded mailboxes, columns — are
  /// carried through an edit rather than dropped.
  const editedDef = () => ({
    ...def,
    accounts: chosenAccounts,
    query: query.trim(),
    sender: sender.trim() || null,
    unread: fromTri(flags.unread),
    starred: fromTri(flags.starred),
    answered: fromTri(flags.answered),
    hasAttachments: attachments,
    toMe,
    notFromMe,
    withinDays: withinDays ? Number(withinDays) : null,
    dateFrom: withinDays ? null : fromDateInput(dateFrom),
    dateTo: withinDays ? null : fromDateInput(dateTo),
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
  });

  const edited = () => ({ ...view, name: name.trim(), icon, def: editedDef() });

  const submit = (event) => {
    event.preventDefault();
    // A starter carries no name of its own — the app translates it — so only a
    // view someone made needs one.
    if (!name.trim() && !view.builtin) return;
    saveView(edited());
    onClose?.();
  };

  /// Moving re-reads the stored view, so anything typed and not yet saved
  /// would be thrown away when the list reloads. Save first.
  const move = (delta) => {
    if (name.trim() || view.builtin) saveView(edited());
    moveView(view.id, delta);
  };

  const tri = (key) => <select data-testid={`view-${key}`} value={flags[key]} aria-label={t(`views.filter.${key}`)}
    onChange={event => setFlags(current => ({ ...current, [key]: event.target.value }))}>
    {TRISTATE.map(([value]) => <option key={value} value={value}>{t(`views.tristate.${value}`)}</option>)}
  </select>;

  return <form className="view-editor" data-testid="view-editor-form" onSubmit={submit}>
    <div className="view-editor-row">
      <input data-testid="view-name" value={name} maxLength={80} aria-label={t('views.name')}
        placeholder={view.builtin ? viewLabel(view, t) : t('views.name')}
        onChange={event => setName(event.target.value)} />
      <select data-testid="view-icon" value={icon} aria-label={t('views.icon')}
        onChange={event => setIcon(event.target.value)}>
        {ICONS.map(option => <option key={option} value={option}>{t(`views.iconName.${option}`)}</option>)}
      </select>
      <button type="button" data-testid="view-move-up" aria-label={t('views.moveUp')} onClick={() => move(-1)}>
        <ChevronUp size={12} />
      </button>
      <button type="button" data-testid="view-move-down" aria-label={t('views.moveDown')} onClick={() => move(1)}>
        <ChevronDown size={12} />
      </button>
    </div>

    <label className="view-editor-row">
      {t('views.filter.query')}
      <input data-testid="view-query" value={query} maxLength={200} aria-label={t('views.filter.query')}
        onChange={event => setQuery(event.target.value)} />
    </label>

    <label className="view-editor-row">
      {t('views.filter.sender')}
      <input data-testid="view-sender" value={sender} maxLength={200} aria-label={t('views.filter.sender')}
        onChange={event => setSender(event.target.value)} />
    </label>

    <div className="view-editor-row">
      <label>{t('views.filter.unread')}{tri('unread')}</label>
      <label>{t('views.filter.starred')}{tri('starred')}</label>
      <label>{t('views.filter.answered')}{tri('answered')}</label>
      <label>
        <input type="checkbox" data-testid="view-attachments" checked={attachments}
          onChange={event => setAttachments(event.target.checked)} />
        {t('views.filter.attachments')}
      </label>
    </div>

    <div className="view-editor-row">
      <label>
        <input type="checkbox" data-testid="view-to-me" checked={toMe}
          onChange={event => setToMe(event.target.checked)} />
        {t('views.filter.toMe')}
      </label>
      <label>
        <input type="checkbox" data-testid="view-not-from-me" checked={notFromMe}
          onChange={event => setNotFromMe(event.target.checked)} />
        {t('views.filter.notFromMe')}
      </label>
    </div>

    {/* A rolling window and a fixed range are two answers to one question, so
        choosing a window puts the two dates away rather than filtering by
        both. */}
    <div className="view-editor-row">
      <label>
        {t('views.filter.within')}
        <select data-testid="view-within" value={withinDays} aria-label={t('views.filter.within')}
          onChange={event => setWithinDays(event.target.value)}>
          <option value="">{t('views.within.any')}</option>
          {WINDOWS.map(days => <option key={days} value={days}>{t(`views.within.${days}`)}</option>)}
        </select>
      </label>
      {!withinDays && <>
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

    {accounts.length > 1 && <div className="view-editor-row">
      <span>{t('views.filter.accounts')}</span>
      {/* No box ticked is every account, not none: a view made before a second
          account was added must not empty itself when one arrives. */}
      {accounts.map(account => <label key={account.id}>
        <input type="checkbox" data-testid={`view-account-${account.id}`} checked={chosenAccounts.includes(account.id)}
          onChange={event => setChosenAccounts(current => (event.target.checked
            ? [...current, account.id]
            : current.filter(id => id !== account.id)))} />
        {account.email}
      </label>)}
      {chosenAccounts.length === 0 && <span className="view-editor-hint">{t('views.filter.allAccounts')}</span>}
    </div>}

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

    {tags.length > 0 && <div className="view-editor-row">
      <span>{t('views.filter.tags')}</span>
      {tags.map(tag => <label key={tag.id}>
        <input type="checkbox" data-testid={`view-tag-${tag.id}`} checked={chosenTags.includes(tag.id)}
          onChange={event => setChosenTags(current => (event.target.checked
            ? [...current, tag.id]
            : current.filter(id => id !== tag.id)))} />
        {tag.name}
      </label>)}
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

    {showPreview && <ViewPreview def={editedDef()} />}

    <div className="view-editor-row">
      <button type="submit">{t('common.save')}</button>
      <button type="button" onClick={() => onClose?.()}>{t('common.cancel')}</button>
      {confirming
        ? <button type="button" data-testid="view-delete-confirm" className="is-danger"
          onClick={() => { deleteView(view.id); onClose?.(); }}>{t('views.deleteConfirm')}</button>
        : <button type="button" data-testid="view-delete" onClick={() => setConfirming(true)}
          aria-label={t('common.delete')}><Trash2 size={12} /></button>}
    </div>
  </form>;
}
