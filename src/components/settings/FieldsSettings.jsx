import React, { useEffect, useState } from 'react';
import { Trash2, Globe, User } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { useFieldStore } from '../../stores/fieldStore';
import { useT } from '../../i18n/index.js';

const KINDS = ['select', 'multi_select', 'date', 'checkbox', 'text'];
const GLOBAL = '*';

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
  const copyFields = useFieldStore(state => state.copyFields);
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

  return <section className="fields-settings" aria-label={t('fields.section')}>
    <div className="sidebar-section-heading"><h2>{t('fields.section')}</h2></div>
    <p className="text-xs text-mail-text-muted">{t('fields.explainer')}</p>

    <ul className="fields-list">
      {schema.map(field => <li key={field.id} className="fields-row" data-testid={`field-row-${field.id}`}>
        <span className="fields-row-name">{field.name}</span>
        <span className="fields-row-kind">{t(`fields.kind.${field.kind}`)}</span>
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
