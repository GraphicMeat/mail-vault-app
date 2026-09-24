import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { ViewPreview } from './ViewPreview';
import { useTagStore } from '../stores/tagStore';
import { useFieldStore } from '../stores/fieldStore';
import { useMailStore } from '../stores/mailStore';
import { useT } from '../i18n/index.js';
import { Button } from './ui/Button';
import { SettingsSection } from './ui/SettingsForm';
import { ViewIcon, VIEW_ICON_PRESETS } from './ViewIcon';
import { ConfirmDialog } from './ConfirmDialog';

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
const splitKeys = text => text.split(/\s*(?:&&|,)\s*|\s+/).filter(Boolean);

export function ViewEditor({ view, onClose, showPreview = true }) {
  const t = useT();
  const saveView = useViewStore(state => state.saveView);
  const deleteView = useViewStore(state => state.deleteView);
  const tags = useTagStore(state => state.tags) || [];
  const accounts = useMailStore(state => state.accounts) || [];
  const accountId = useMailStore(state => state.activeAccountId);
  const schema = useFieldStore(state => state.fieldsFor(accountId)) || [];

  const def = view.def || {};
  const [name, setName] = useState(view.name || '');
  const [icon, setIcon] = useState(view.icon || 'tag');
  const [queryKeys, setQueryKeys] = useState(() => [...new Set(splitKeys(def.query || ''))]);
  const [queryInput, setQueryInput] = useState('');
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
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  const filterFor = id => fieldFilters[id] || NO_FILTER;
  const setFilter = (id, patch) =>
    setFieldFilters(current => ({ ...current, [id]: { ...(current[id] || NO_FILTER), ...patch } }));

  const pendingKeys = splitKeys(queryInput);
  const allKeys = [...new Set([...queryKeys, ...pendingKeys])];
  const addKeys = () => {
    if (!queryInput.trim()) return;
    setQueryKeys(allKeys);
    setQueryInput('');
  };

  /// What the form currently says, as a definition. Spread over the stored one
  /// so the parts this form does not offer — excluded mailboxes, columns — are
  /// carried through an edit rather than dropped.
  const editedDef = () => ({
    ...def,
    accounts: chosenAccounts,
    query: allKeys.join(' '),
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

  const submit = async (event) => {
    event.preventDefault();
    // A starter carries no name of its own — the app translates it — so only a
    // view someone made needs one.
    if (!name.trim() && !view.builtin) return;
    setSaveError('');
    setSaving(true);
    try {
      await saveView(edited());
      onClose?.(true);
    } catch (cause) {
      setSaveError(cause?.message || String(cause));
    } finally {
      setSaving(false);
    }
  };

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
      <input data-testid="view-name" value={name} maxLength={80} aria-label={t('views.name')}
        placeholder={view.builtin ? viewLabel(view, t) : t('views.name')}
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
        <input type="text" data-testid="view-emoji" className={`view-emoji-input${icon.startsWith('emoji:') ? ' is-selected' : ''}`}
          aria-label={`${t('views.icon')} (😀)`} placeholder="😀"
          value={icon.startsWith('emoji:') ? icon.slice(6) : ''}
          onChange={event => setIcon(event.target.value ? `emoji:${event.target.value}` : 'tag')} />
      </div>
    </div>

    <div className="view-choice-field">
      <label htmlFor="view-query">{t('views.filter.query')}</label>
      <div className="view-query-keys" aria-label={t('views.filter.query')}>
        {queryKeys.map(key => <button key={key} type="button" className="view-query-key"
          aria-label={`${t('common.remove')} ${key}`}
          onClick={() => setQueryKeys(current => current.filter(item => item !== key))}>
          {key}<X size={12} aria-hidden="true" />
        </button>)}
        <input id="view-query" data-testid="view-query" value={queryInput} maxLength={200}
          aria-label={t('views.filter.query')}
          onChange={event => setQueryInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && queryInput.trim()) { event.preventDefault(); addKeys(); } }}
          onBlur={addKeys} />
      </div>
    </div>

    <label className="view-editor-row">
      {t('views.filter.sender')}
      <input data-testid="view-sender" value={sender} maxLength={200} aria-label={t('views.filter.sender')}
        onChange={event => setSender(event.target.value)} />
    </label>

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

    </SettingsSection>

    {(tags.length > 0 || schema.length > 0) && <SettingsSection title={t('views.filter.more')} description={t('views.moreHint')}>
    {tags.length > 0 && <div className="view-choice-field">
      <span>{t('views.filter.tags')}</span>
      <div className="view-choice-group" role="group" aria-label={t('views.filter.tags')}>
        {tags.map(tag => <button key={tag.id} type="button" data-testid={`view-tag-${tag.id}`}
          className="view-choice-button" aria-pressed={chosenTags.includes(tag.id)}
          onClick={() => setChosenTags(current => (current.includes(tag.id)
            ? current.filter(id => id !== tag.id)
            : [...current, tag.id]))}>{tag.name}</button>)}
      </div>
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
