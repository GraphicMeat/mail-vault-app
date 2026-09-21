import React, { useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useFieldStore, requestRowValues, requestSchema, fieldRowKey } from '../stores/fieldStore';
import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { useT } from '../i18n/index.js';

/// The custom fields of the message being read, editable in place.
///
/// Nothing here writes to the message: a value is MailVault's own note about
/// it, stored locally and keyed to the message's identity.
const EMPTY_VALUES = {};

export function FieldStrip({ email, className = '' }) {
  const t = useT();
  const fields = useFieldStore(state => state.fields);
  const byRow = useFieldStore(state => state.byRow);
  const setValue = useFieldStore(state => state.setValue);
  const location = email ? resolveEmailLocation(email, useMailStore.getState()) : null;
  const schema = (location && fields[location.accountId]) || [];

  useEffect(() => {
    if (!location) return;
    // A unified list shows several accounts, and only the active one's schema
    // is loaded at startup. Without this the strip is simply absent for the
    // others — no error, no empty state.
    requestSchema(location.accountId);
    if (schema.length) requestRowValues(email, location);
  });

  if (!location || !schema.length) return null;
  // Read from the subscribed cache, not from a `getState()` snapshot: a value
  // that arrives after the strip mounts has to repaint it.
  const values = byRow[fieldRowKey(location.accountId, location.mailbox, email.uid)] || EMPTY_VALUES;

  const store = (field, value) => setValue(email, location, field.id, value);

  const input = (field) => {
    const value = values?.[field.id];
    const testId = `field-input-${field.id}`;
    if (field.kind === 'checkbox') {
      return <input type="checkbox" data-testid={testId} checked={value === true}
        aria-label={field.name} onChange={event => store(field, event.target.checked)} />;
    }
    if (field.kind === 'date') {
      return <input type="date" data-testid={testId} value={typeof value === 'string' ? value : ''}
        aria-label={field.name} onChange={event => store(field, event.target.value || null)} />;
    }
    if (field.kind === 'select') {
      // A native <option> cannot be tinted portably, so the chosen choice's
      // colour is shown beside the control instead of inside it.
      const chosen = field.options.find(option => option.id === value);
      return <>
        {chosen?.color && <span className="field-swatch" aria-hidden="true" style={{ '--tag-color': chosen.color }} />}
        <select data-testid={testId} value={typeof value === 'string' ? value : ''} aria-label={field.name}
          onChange={event => store(field, event.target.value || null)}>
          <option value="">{t('fields.noValue')}</option>
          {field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </>;
    }
    if (field.kind === 'multi_select') {
      const chosen = Array.isArray(value) ? value : [];
      return <span className="field-multi" data-testid={testId}>
        {field.options.map(option => <label key={option.id} className={chosen.includes(option.id) ? 'is-chosen' : ''}
          style={chosen.includes(option.id) && option.color ? { '--tag-color': option.color } : undefined}>
          <input type="checkbox" checked={chosen.includes(option.id)}
            onChange={event => store(field, event.target.checked
              ? [...chosen, option.id]
              : chosen.filter(id => id !== option.id))} />
          {option.label}
        </label>)}
      </span>;
    }
    return <input type="text" data-testid={testId} defaultValue={typeof value === 'string' ? value : ''}
      aria-label={field.name} maxLength={500}
      onBlur={event => {
        const next = event.target.value.trim();
        if (next !== (typeof value === 'string' ? value : '')) store(field, next || null);
      }} />;
  };

  return <div className={`field-strip ${className}`} aria-label={t('fields.section')}>
    {schema.map(field => <span key={field.id} className="field-strip-item">
      <span className="field-strip-name" data-testid={`field-name-${field.id}`}>{field.name}</span>
      {input(field)}
    </span>)}
  </div>;
}
