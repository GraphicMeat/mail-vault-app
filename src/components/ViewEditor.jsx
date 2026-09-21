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
  const [fieldValues, setFieldValues] = useState(() => Object.fromEntries(
    (def.fields || []).map(filter => [filter.fieldId, typeof filter.value === 'string' ? filter.value : '']),
  ));
  const [confirming, setConfirming] = useState(false);

  const submit = (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    // A starter carries no name of its own — the app translates it — so only a
    // view someone made needs one.
    if (!trimmed && !view.builtin) return;
    saveView({
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
        fields: Object.entries(fieldValues)
          .filter(([, value]) => value)
          .map(([fieldId, value]) => ({ fieldId, op: 'is', value })),
      },
    });
    onClose?.();
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
      <button type="button" data-testid="view-move-up" aria-label={t('views.moveUp')} onClick={() => moveView(view.id, -1)}>
        <ChevronUp size={12} />
      </button>
      <button type="button" data-testid="view-move-down" aria-label={t('views.moveDown')} onClick={() => moveView(view.id, 1)}>
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
        {field.options?.length
          ? <select data-testid={`view-field-${field.id}`} value={fieldValues[field.id] || ''} aria-label={field.name}
            onChange={event => setFieldValues(current => ({ ...current, [field.id]: event.target.value }))}>
            <option value="">{t('views.tristate.any')}</option>
            {field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <input data-testid={`view-field-${field.id}`} value={fieldValues[field.id] || ''} maxLength={200}
            aria-label={field.name}
            onChange={event => setFieldValues(current => ({ ...current, [field.id]: event.target.value }))} />}
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
