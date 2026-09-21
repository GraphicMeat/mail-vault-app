import React, { useEffect, useState } from 'react';
import { Trash2, Globe, User, ChevronUp, ChevronDown } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { useFieldStore } from '../../stores/fieldStore';
import { useT } from '../../i18n/index.js';

const KINDS = ['select', 'multi_select', 'date', 'checkbox', 'text'];
const GLOBAL = '*';

/// The choices a select or multi-select offers. Ids never change once given
/// out: a message holds the id, so renaming a choice must leave every value
/// exactly where it is.
function OptionEditor({ field, onSave, usageOf }) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [removing, setRemoving] = useState(null);
  const [usage, setUsage] = useState({});
  // The list being edited, not the list this render was handed. The save is a
  // daemon round-trip and blur fires when you move to the next control, so a
  // second edit routinely lands before the store answers — rebuilding from the
  // prop would drop the first one.
  const [options, setOptions] = useState(field.options || []);
  const [known, setKnown] = useState(field.options || []);
  if (field.options !== known) {
    // The store came back (or someone else changed the field): adopt it.
    setKnown(field.options || []);
    setOptions(field.options || []);
  }

  const apply = (next) => {
    setOptions(next);
    onSave(next);
  };

  const add = (event) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    const taken = options.some(option => option.label.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
    if (taken) return;
    setLabel('');
    apply([...options, {
      id: globalThis.crypto?.randomUUID?.() || `option-${Date.now()}-${options.length}`,
      label: trimmed,
      color: '',
    }]);
  };

  const rename = (option, next) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === option.label) return;
    apply(options.map(item => (item.id === option.id ? { ...item, label: trimmed } : item)));
  };

  const recolour = (option, color) =>
    apply(options.map(item => (item.id === option.id ? { ...item, color } : item)));

  const askToRemove = async (option) => {
    setRemoving(option.id);
    setUsage(await usageOf(field.id));
  };

  return <span className="field-options" data-testid={`field-options-${field.id}`}>
    {options.map(option => <span key={option.id} className="field-option">
      <input data-testid={`option-label-${option.id}`} defaultValue={option.label} maxLength={80}
        aria-label={option.label} onBlur={event => rename(option, event.target.value)} />
      <input type="color" data-testid={`option-color-${option.id}`} value={option.color || '#808080'}
        aria-label={t('fields.optionColor')} onChange={event => recolour(option, event.target.value)} />
      {removing === option.id
        ? <button type="button" data-testid={`option-remove-confirm-${option.id}`}
          onClick={() => { setRemoving(null); apply(options.filter(item => item.id !== option.id)); }}>
          {t('fields.optionRemoveConfirm', { count: usage[option.id] || 0 })}
        </button>
        : <button type="button" data-testid={`option-remove-${option.id}`} onClick={() => askToRemove(option)}
          aria-label={`${t('common.remove')}: ${option.label}`}>×</button>}
    </span>)}
    <form data-testid={`new-option-form-${field.id}`} onSubmit={add}>
      <input data-testid={`new-option-${field.id}`} value={label} maxLength={80}
        placeholder={t('fields.newOption')} aria-label={t('fields.newOption')}
        onChange={event => setLabel(event.target.value)} />
    </form>
  </span>;
}

/// The custom fields of the active account: what they are called, what kind of
/// answer they take, and whether every account shares them.
export function FieldsSettings() {
  const t = useT();
  const accountId = useMailStore(state => state.activeAccountId);
  const accounts = useMailStore(state => state.accounts) || [];
  const fields = useFieldStore(state => state.fields);
  const loadFields = useFieldStore(state => state.loadFields);
  const saveField = useFieldStore(state => state.saveField);
  const deleteField = useFieldStore(state => state.deleteField);
  const moveField = useFieldStore(state => state.moveField);
  const copyFields = useFieldStore(state => state.copyFields);
  const optionUsage = useFieldStore(state => state.optionUsage);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('select');
  const [confirming, setConfirming] = useState(null);
  const [copyFrom, setCopyFrom] = useState('');
  const [picked, setPicked] = useState([]);

  useEffect(() => { if (accountId) loadFields(accountId); }, [accountId, loadFields]);
  useEffect(() => { if (copyFrom) loadFields(copyFrom); }, [copyFrom, loadFields]);

  const schema = fields[accountId] || [];
  const others = accounts.filter(account => account.id !== accountId);
  const sourceFields = (fields[copyFrom] || []).filter(field => field.scope !== GLOBAL);

  const add = (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setName('');
    saveField(accountId, {
      id: globalThis.crypto?.randomUUID?.() || `field-${Date.now()}`,
      scope: accountId,
      name: trimmed,
      kind,
      options: kind === 'select' || kind === 'multi_select' ? [] : [],
      position: schema.length,
    });
  };

  /// Sharing is a scope change, not a copy: the field keeps its id, so every
  /// value already given to it stays attached.
  const toggleScope = (field) => saveField(accountId, {
    ...field,
    scope: field.scope === GLOBAL ? accountId : GLOBAL,
  });

  const saveOptions = (field, options) => saveField(accountId, { ...field, options });

  /// Where a field sits inside its own scope. The list renders the global
  /// fields before the account's own, so a button at the end of a group would
  /// otherwise ask for a move across that line — which the daemon refuses
  /// anyway, silently.
  const placeInScope = (field) => {
    const group = schema.filter(item => item.scope === field.scope);
    return [group.findIndex(item => item.id === field.id), group.length];
  };
  const canMoveUp = field => placeInScope(field)[0] > 0;
  const canMoveDown = (field) => {
    const [at, size] = placeInScope(field);
    return at >= 0 && at < size - 1;
  };

  return <section className="fields-settings" aria-label={t('fields.section')}>
    <div className="sidebar-section-heading"><h2>{t('fields.section')}</h2></div>
    <p className="text-xs text-mail-text-muted">{t('fields.explainer')}</p>

    <ul className="fields-list">
      {schema.map(field => <li key={field.id} className="fields-row" data-testid={`field-row-${field.id}`}>
        <span className="fields-row-name">{field.name}</span>
        <span className="fields-row-kind">{t(`fields.kind.${field.kind}`)}</span>
        <button type="button" data-testid={`field-move-up-${field.id}`} aria-label={t('fields.moveUp')}
          disabled={!canMoveUp(field)} onClick={() => moveField(accountId, field.id, -1)}>
          <ChevronUp size={12} />
        </button>
        <button type="button" data-testid={`field-move-down-${field.id}`} aria-label={t('fields.moveDown')}
          disabled={!canMoveDown(field)} onClick={() => moveField(accountId, field.id, 1)}>
          <ChevronDown size={12} />
        </button>
        <button type="button" data-testid={`field-scope-${field.id}`} onClick={() => toggleScope(field)}
          title={t(field.scope === GLOBAL ? 'fields.scope.makeAccount' : 'fields.scope.makeGlobal')}>
          {field.scope === GLOBAL ? <Globe size={12} /> : <User size={12} />}
          {t(field.scope === GLOBAL ? 'fields.scope.global' : 'fields.scope.account')}
        </button>
        {confirming === field.id
          ? <button type="button" data-testid={`field-delete-confirm-${field.id}`}
            onClick={() => { setConfirming(null); deleteField(accountId, field.id); }}>
            {t('fields.deleteConfirm')}
          </button>
          : <button type="button" data-testid={`field-delete-${field.id}`} onClick={() => setConfirming(field.id)}
            title={t('common.delete')} aria-label={`${t('common.delete')}: ${field.name}`}>
            <Trash2 size={12} />
          </button>}
        {(field.kind === 'select' || field.kind === 'multi_select')
          && <OptionEditor field={field} onSave={options => saveOptions(field, options)} usageOf={optionUsage} />}
      </li>)}
    </ul>

    <form className="fields-add" data-testid="new-field-form" onSubmit={add}>
      <input data-testid="new-field-name" value={name} maxLength={80} placeholder={t('fields.newName')}
        aria-label={t('fields.newName')} onChange={event => setName(event.target.value)} />
      <select data-testid="new-field-kind" value={kind} aria-label={t('fields.newKind')}
        onChange={event => setKind(event.target.value)}>
        {KINDS.map(option => <option key={option} value={option}>{t(`fields.kind.${option}`)}</option>)}
      </select>
      <button type="submit">{t('fields.add')}</button>
    </form>

    {others.length > 0 && <div className="fields-copy">
      <select data-testid="copy-from-account" value={copyFrom} aria-label={t('fields.copyFrom')}
        onChange={event => { setCopyFrom(event.target.value); setPicked([]); }}>
        <option value="">{t('fields.copyFrom')}</option>
        {others.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}
      </select>
      {sourceFields.map(field => <label key={field.id}>
        <input type="checkbox" data-testid={`copy-field-${field.id}`} checked={picked.includes(field.id)}
          onChange={event => setPicked(current => (event.target.checked
            ? [...current, field.id]
            : current.filter(id => id !== field.id)))} />
        {field.name}
      </label>)}
      {sourceFields.length > 0 && <button type="button" data-testid="copy-fields-run"
        disabled={!picked.length}
        onClick={() => { copyFields(picked, accountId); setPicked([]); }}>
        {t('fields.copyRun')}
      </button>}
    </div>}
  </section>;
}
