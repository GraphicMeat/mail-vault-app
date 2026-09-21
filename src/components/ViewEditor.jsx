import React, { useState } from 'react';
import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { useViewStore, viewLabel } from '../stores/viewStore';
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

export function ViewEditor({ view, onClose }) {
  const t = useT();
  const saveView = useViewStore(state => state.saveView);
  const deleteView = useViewStore(state => state.deleteView);
  const moveView = useViewStore(state => state.moveView);
  const tags = useTagStore(state => state.tags) || [];
  const accountId = useMailStore(state => state.activeAccountId);
  const schema = useFieldStore(state => state.fieldsFor(accountId)) || [];

  const def = view.def || {};
  const [name, setName] = useState(view.name || '');
  const [icon, setIcon] = useState(view.icon || 'tag');
  const [query, setQuery] = useState(def.query || '');
  const [flags, setFlags] = useState({
    unread: toTri(def.unread), starred: toTri(def.starred), answered: toTri(def.answered),
  });
  const [attachments, setAttachments] = useState(!!def.hasAttachments);
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
  const [confirming, setConfirming] = useState(false);

  const filterFor = id => fieldFilters[id] || NO_FILTER;
  const setFilter = (id, patch) =>
    setFieldFilters(current => ({ ...current, [id]: { ...(current[id] || NO_FILTER), ...patch } }));

  /// What the form currently says, as a view.
  const edited = () => {
    const trimmed = name.trim();
    return {
      ...view,
      name: trimmed,
      icon,
      def: {
        ...def,
        query: query.trim(),
        unread: fromTri(flags.unread),
        starred: fromTri(flags.starred),
        answered: fromTri(flags.answered),
        hasAttachments: attachments,
        tags: chosenTags,
        // A field nobody touched is not a filter — an empty value still means
        // "any" — but `isSet`/`isEmpty` are filters that carry no value.
        fields: Object.entries(fieldFilters)
          .filter(([, filter]) => filter.value || VALUELESS.includes(filter.op))
          .map(([fieldId, filter]) => (VALUELESS.includes(filter.op)
            ? { fieldId, op: filter.op }
            : { fieldId, op: filter.op, value: filter.value })),
        group: group || null,
      },
    };
  };

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

    {/* Outside the schema block on purpose: none/sender/date need no schema,
        and an app with no account yet still has a grouping to choose. */}
    <label className="view-editor-row">
      {t('views.filter.group')}
      <select data-testid="view-group" value={group} aria-label={t('views.filter.group')}
        onChange={event => setGroup(event.target.value)}>
        <option value="">{t('views.group.none')}</option>
        <option value="sender">{t('views.group.sender')}</option>
        <option value="date">{t('views.group.date')}</option>
        {schema.map(field => <option key={field.id} value={`field:${field.id}`}>{field.name}</option>)}
      </select>
    </label>

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
